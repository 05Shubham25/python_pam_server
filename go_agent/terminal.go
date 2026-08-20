package main

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Shell is the platform shell process behind a terminal session.
// POSIX gets a real PTY; Windows gets cmd.exe over pipes (no kernel echo,
// so the worker shims echo manually).
type Shell interface {
	Start() error
	Read(buf []byte) (int, error) // blocking; io.EOF when the shell exits
	Write(b []byte) error
	Resize(cols, rows int)
	Stop()
	ManualEcho() bool
}

// TerminalWorker pumps bytes between the broker WebSocket and a shell.
type TerminalWorker struct {
	ws      *websocket.Conn
	session SessionInfo
	shell   Shell
	writeMu sync.Mutex
}

func NewTerminalWorker(ws *websocket.Conn, session SessionInfo) (*TerminalWorker, error) {
	sh, err := NewShell(120, 30)
	if err != nil {
		return nil, err
	}
	return &TerminalWorker{ws: ws, session: session, shell: sh}, nil
}

func (w *TerminalWorker) writeMessage(msgType int, data []byte) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	return w.ws.WriteMessage(msgType, data)
}

func (w *TerminalWorker) writeControl(msgType int, data []byte, deadline time.Time) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	return w.ws.WriteControl(msgType, data, deadline)
}

func (w *TerminalWorker) Run() {
	defer w.shell.Stop()

	if err := w.shell.Start(); err != nil {
		w.sendCtrl(map[string]any{"t": "bye", "reason": "shell start failed: " + err.Error()})
		return
	}
	w.sendCtrl(map[string]any{"t": "hello", "mode": "terminal"})

	done := make(chan struct{}, 2) // closed-ish signal from either pump
	finish := func() {
		select {
		case done <- struct{}{}:
		default:
		}
	}

	// keepalive: ping so half-open connections get reaped
	w.ws.SetReadDeadline(time.Now().Add(60 * time.Second))
	w.ws.SetPongHandler(func(string) error {
		w.ws.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if err := w.writeControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					return
				}
			}
		}
	}()

	// pump out: shell -> websocket
	go func() {
		defer finish()
		buf := make([]byte, 65536)
		for {
			n, err := w.shell.Read(buf)
			if err != nil || n == 0 {
				w.sendCtrl(map[string]any{"t": "bye", "reason": "shell exited"})
				w.ws.Close()
				return
			}
			frame := append([]byte{TAG_TTY}, buf[:n]...)
			if err := w.writeMessage(websocket.BinaryMessage, frame); err != nil {
				return
			}
		}
	}()

	// pump in: websocket -> shell (runs on this goroutine)
	go func() {
		defer finish()
		for {
			w.ws.SetReadDeadline(time.Now().Add(60 * time.Second))
			_, msg, err := w.ws.ReadMessage()
			if err != nil {
				return
			}
			if len(msg) == 0 {
				continue
			}
			tag, payload := msg[0], msg[1:]
			switch tag {
			case TAG_TTY:
				if w.shell.ManualEcho() {
					w.shell.Write(translatePipeInput(payload))
					_ = w.writeMessage(websocket.BinaryMessage,
						append([]byte{TAG_TTY}, translateEcho(payload)...))
				} else {
					w.shell.Write(payload)
				}
			case TAG_CTRL:
				var c struct {
					T    string `json:"t"`
					Cols int    `json:"cols"`
					Rows int    `json:"rows"`
				}
				if json.Unmarshal(payload, &c) == nil && c.T == "resize" {
					w.shell.Resize(c.Cols, c.Rows)
				}
			}
		}
	}()

	<-done
	log.Printf("terminal session %s ended", w.session.ID)
}

func (w *TerminalWorker) sendCtrl(msg map[string]any) {
	data, _ := json.Marshal(msg)
	frame := append([]byte{TAG_CTRL}, data...)
	_ = w.writeMessage(websocket.BinaryMessage, frame)
}

// translatePipeInput adapts browser input for pipe-mode shells: CR becomes
// CRLF, backspace is dropped (pipe shells don't line-edit).
func translatePipeInput(data []byte) []byte {
	var out []byte
	for _, b := range data {
		switch b {
		case 0x0D:
			out = append(out, 0x0D, 0x0A)
		case 0x7F, 0x08:
			// dropped from stdin
		default:
			out = append(out, b)
		}
	}
	return out
}

// translateEcho renders typed keys (incl. backspace) back to the browser
// because pipe shells don't echo.
func translateEcho(data []byte) []byte {
	var out []byte
	for _, b := range data {
		switch b {
		case 0x0D:
			out = append(out, 0x0D, 0x0A)
		case 0x7F, 0x08:
			out = append(out, 0x08, ' ', 0x08)
		default:
			out = append(out, b)
		}
	}
	return out
}
