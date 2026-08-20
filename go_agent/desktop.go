package main

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// CaptureBackend grabs screen frames as JPEG.
type CaptureBackend interface {
	Probe() error
	Open() error
	Size() (int, int)
	CaptureJPEG() ([]byte, error) // nil, nil = unchanged frame
	SetQuality(q int)
	Close()
}

// InputBackend injects mouse/keyboard events.
type InputBackend interface {
	Open() error
	ApplyEvent(ev inputEvent)
	ReleaseAll()
	Close()
}

// inputEvent is a decoded browser input control message.
type inputEvent struct {
	T    string   `json:"t"`
	X    float64  `json:"x"`
	Y    float64  `json:"y"`
	B    int      `json:"b"`
	Clk  int      `json:"clk"`
	Dy   float64  `json:"dy"`
	Key  string   `json:"key"`
	Mod  []string `json:"mod"`
	Down *bool    `json:"down"`
}

// DesktopWorker streams JPEG frames to the browser and applies its input
// events locally.
type DesktopWorker struct {
	ws      *websocket.Conn
	session SessionInfo
	capture CaptureBackend
	input   InputBackend
	fps     int
	writeMu sync.Mutex
}

func NewDesktopWorker(ws *websocket.Conn, session SessionInfo, monitor, fps, quality int) (*DesktopWorker, error) {
	cap, in, err := NewDesktopBackends(monitor, quality)
	if err != nil {
		return nil, err
	}
	return &DesktopWorker{ws: ws, session: session, capture: cap, input: in, fps: fps}, nil
}

func (w *DesktopWorker) writeMessage(msgType int, data []byte) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	return w.ws.WriteMessage(msgType, data)
}

func (w *DesktopWorker) writeControlMsg(msgType int, data []byte, deadline time.Time) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	return w.ws.WriteControl(msgType, data, deadline)
}

const (
	forceRefreshSecs = 2.0 // resend last frame even if unchanged
	brokenFailLimit  = 30  // consecutive failed captures before giving up
)

func (w *DesktopWorker) Run() {
	defer func() {
		w.input.Close()
		w.capture.Close()
		log.Printf("desktop session %s ended", w.session.ID)
	}()

	if err := w.capture.Probe(); err != nil {
		w.sendCtrl(map[string]any{"t": "bye", "reason": err.Error()})
		w.ws.Close()
		return
	}
	if err := w.capture.Open(); err != nil {
		w.sendCtrl(map[string]any{"t": "bye", "reason": "screen capture unavailable: " + err.Error()})
		w.ws.Close()
		return
	}
	_ = w.input.Open()

	width, height := w.capture.Size()
	w.sendCtrl(map[string]any{"t": "hello", "mode": "desktop", "width": width, "height": height})

	// Bounded drop-oldest frame queue: slow networks degrade fps, capture
	// never blocks. nil payload means "capture is broken, end session".
	frames := make(chan []byte, 2)
	done := make(chan struct{})
	doneOnce := func() {
		select {
		case <-done:
		default:
			close(done)
		}
	}

	// keepalive ping loop
	w.ws.SetReadDeadline(time.Now().Add(60 * time.Second))
	w.ws.SetPongHandler(func(string) error {
		w.ws.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if err := w.writeControlMsg(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					doneOnce()
					return
				}
			}
		}
	}()

	// capture loop
	interval := time.Second / time.Duration(max(w.fps, 1))
	go func() {
		beat := time.Now()
		forceAt := time.Now().Add(time.Duration(forceRefreshSecs * float64(time.Second)))
		var lastJPEG []byte
		failures := 0
		sent, bytes5s := 0, 0
		statWindow := time.Now().Add(5 * time.Second)
		for {
			select {
			case <-done:
				return
			default:
			}
			now := time.Now()
			force := now.After(forceAt)
			jpeg, err := w.capture.CaptureJPEG()
			if err != nil {
				jpeg = nil
			}
			if jpeg != nil {
				failures = 0
				lastJPEG = jpeg
				forceAt = now.Add(time.Duration(forceRefreshSecs * float64(time.Second)))
			} else if force && lastJPEG != nil {
				jpeg = lastJPEG
				forceAt = now.Add(time.Duration(forceRefreshSecs * float64(time.Second)))
			} else if err != nil {
				failures++
				if failures%10 == 1 {
					log.Printf("capture error (%d/%d): %v", failures, brokenFailLimit, err)
				}
				if failures >= brokenFailLimit {
					log.Printf("too many capture failures: %v — stopping capture", err)
					select {
					case frames <- nil:
					default:
					}
					return
				}
			} else {
				failures = 0
			}
			if jpeg != nil {
				sent++
				bytes5s += len(jpeg)
				select {
				case frames <- jpeg:
				default: // queue full — drop the oldest frame
					select {
					case <-frames:
					default:
					}
					select {
					case frames <- jpeg:
					default:
					}
				}
			}
			if now.After(statWindow) {
				log.Printf("stream: %.1f fps, ~%d KB/frame",
					float64(sent)/5.0, (bytes5s/1024)/max(sent, 1))
				sent, bytes5s = 0, 0
				statWindow = now.Add(5 * time.Second)
			}
			beat = beat.Add(interval)
			if sleep := time.Until(beat); sleep > 0 {
				select {
				case <-done:
					return
				case <-time.After(sleep):
				}
			} else {
				beat = time.Now() // fell behind — reset cadence
			}
		}
	}()

	// pump out: frames -> websocket
	go func() {
		defer doneOnce()
		for {
			select {
			case <-done:
				return
			case jpeg := <-frames:
				if jpeg == nil {
					log.Printf("desktop session %s: screen capture stopped", w.session.ID)
					w.sendCtrl(map[string]any{"t": "bye", "reason": "screen capture stopped"})
					w.ws.Close()
					return
				}
				frame := append([]byte{TAG_JPEG}, jpeg...)
				if err := w.writeMessage(websocket.BinaryMessage, frame); err != nil {
					log.Printf("desktop session %s write error: %v", w.session.ID, err)
					return
				}
			}
		}
	}()

	// pump in: control frames (quality + input events)
	go func() {
		defer doneOnce()
		for {
			w.ws.SetReadDeadline(time.Now().Add(60 * time.Second))
			_, msg, err := w.ws.ReadMessage()
			if err != nil {
				log.Printf("desktop session %s read error: %v", w.session.ID, err)
				return
			}
			if len(msg) == 0 || msg[0] != TAG_CTRL {
				continue
			}
			var ev struct {
				T string `json:"t"`
				Q int    `json:"q"`
			}
			if json.Unmarshal(msg[1:], &ev) != nil {
				continue
			}
			if ev.T == "quality" {
				w.capture.SetQuality(ev.Q)
				continue
			}
			var input inputEvent
			if json.Unmarshal(msg[1:], &input) == nil {
				w.input.ApplyEvent(input)
			}
		}
	}()

	<-done
}

func (w *DesktopWorker) sendCtrl(msg map[string]any) {
	data, _ := json.Marshal(msg)
	frame := append([]byte{TAG_CTRL}, data...)
	_ = w.writeMessage(websocket.BinaryMessage, frame)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func clampQuality(q int) int {
	if q < 30 {
		return 30
	}
	if q > 90 {
		return 90
	}
	return q
}
