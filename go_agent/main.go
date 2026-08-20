// PAM Agent (Go) — connects a machine to the PAM control plane.
//
// Terminal sessions: real PTY on POSIX, pipes on Windows.
// Desktop sessions:  screen capture -> tagged JPEG frames over the broker,
//                    browser input events -> local injection.
//
// Usage:
//
//	pam-agent --server http://192.168.1.35:8000 --agent-id agt_XXXX
package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

type Config struct {
	Server     string
	AgentID    string
	MaxSession int
	Monitor    int
	FPS        int
	Quality    int
	NoDesktop  bool
	NoTerminal bool
}

// Agent supervises the heartbeat/poll loops and per-session workers.
type Agent struct {
	cfg        *Config
	control    *ControlClient
	mu         sync.Mutex
	workers    map[string]bool
	lastAttach map[string]time.Time
	shutdown   chan struct{}
}

func NewAgent(cfg *Config) *Agent {
	return &Agent{
		cfg:        cfg,
		control:    NewControlClient(cfg.Server, cfg.AgentID),
		workers:    map[string]bool{},
		lastAttach: map[string]time.Time{},
		shutdown:   make(chan struct{}),
	}
}

func (a *Agent) Run() {
	log.Printf("pam_agent v%s | agent %s -> %s (terminal=%v desktop=%v)",
		AgentVersion, a.cfg.AgentID, a.cfg.Server, !a.cfg.NoTerminal, !a.cfg.NoDesktop)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		a.stop()
	}()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); a.heartbeatLoop() }()
	go func() { defer wg.Done(); a.pollLoop() }()
	wg.Wait()

	// best-effort: tell the control plane we went offline
	a.control.Offline()
	log.Printf("agent stopped cleanly")
}

func (a *Agent) stop() {
	select {
	case <-a.shutdown:
	default:
		close(a.shutdown)
	}
}

func (a *Agent) heartbeatLoop() {
	backoff := time.Second
	unknownWarned := false
	for {
		select {
		case <-a.shutdown:
			return
		case <-time.After(backoff):
		}
		res, err := a.control.Heartbeat()
		if err != nil {
			log.Printf("server unreachable (%v) — retrying in %.0fs", err, backoff.Seconds())
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
			continue
		}
		if ok, _ := res["ok"].(bool); !ok {
			if !unknownWarned {
				log.Printf("agent id '%s' is NOT registered — register this host in the PAM UI (Hosts -> Register Host) with this exact agent id; it will go online automatically once registered", a.cfg.AgentID)
				unknownWarned = true
			}
		} else {
			if unknownWarned {
				log.Printf("agent id '%s' now registered — online", a.cfg.AgentID)
				unknownWarned = false
			}
		}
		backoff = time.Second
		// heartbeat cadence, but keep the backoff loop responsive to shutdown
		select {
		case <-a.shutdown:
			return
		case <-time.After(HeartbeatInterval * time.Second):
		}
	}
}

func (a *Agent) pollLoop() {
	for {
		select {
		case <-a.shutdown:
			return
		case <-time.After(PollInterval * time.Second):
		}
		sessions, err := a.control.ActiveSessions()
		if err != nil {
			continue // heartbeat loop already logs connectivity
		}
		a.reconcile(sessions)
	}
}

func (a *Agent) reconcile(sessions []SessionInfo) {
	a.mu.Lock()
	for _, s := range sessions {
		if s.Status != "active" || a.workers[s.ID] {
			continue
		}
		// throttle crash loops: one attach attempt per session per window
		if time.Since(a.lastAttach[s.ID]) < AttachRetrySeconds*time.Second {
			continue
		}
		if s.SessionType == "rdp" && a.cfg.NoDesktop {
			continue
		}
		if s.SessionType != "rdp" && a.cfg.NoTerminal {
			continue
		}
		if len(a.workers) >= a.cfg.MaxSession {
			log.Printf("max concurrent sessions reached — skipping %s", s.ID)
			continue
		}
		a.lastAttach[s.ID] = time.Now()
		a.workers[s.ID] = true
		log.Printf("attached to %s session %s", s.SessionType, s.ID)
		go a.runSession(s)
	}
	a.mu.Unlock()
}

func (a *Agent) runSession(s SessionInfo) {
	defer func() {
		a.mu.Lock()
		delete(a.workers, s.ID)
		a.mu.Unlock()
	}()

	ws, err := a.control.SessionWS(s.ID)
	if err != nil {
		log.Printf("session %s connection error: %v", s.ID, err)
		return
	}
	defer ws.Close()

	if s.SessionType == "rdp" {
		worker, err := NewDesktopWorker(ws, s, a.cfg.Monitor, a.cfg.FPS, a.cfg.Quality)
		if err != nil {
			log.Printf("session %s desktop init error: %v", s.ID, err)
			return
		}
		worker.Run()
	} else {
		worker, err := NewTerminalWorker(ws, s)
		if err != nil {
			log.Printf("session %s terminal init error: %v", s.ID, err)
			return
		}
		worker.Run()
	}
}

func main() {
	log.SetFlags(log.Ltime)
	log.SetPrefix("")

	cfg := &Config{}
	flag.StringVar(&cfg.Server, "server", "", "control plane base URL, e.g. http://10.0.0.2:8000 (required)")
	flag.StringVar(&cfg.AgentID, "agent-id", "", "agent_id of the registered host (required)")
	flag.IntVar(&cfg.MaxSession, "max-sessions", 5, "max concurrent sessions")
	flag.IntVar(&cfg.Monitor, "monitor", 1, "screen to capture for desktop sessions (1 = primary)")
	flag.IntVar(&cfg.FPS, "fps", 10, "desktop capture rate cap")
	flag.IntVar(&cfg.Quality, "quality", 60, "JPEG quality 30-90")
	flag.BoolVar(&cfg.NoDesktop, "no-desktop", false, "disable screen capture / input injection")
	flag.BoolVar(&cfg.NoTerminal, "no-terminal", false, "disable terminal sessions")
	flag.Parse()

	if cfg.Server == "" || cfg.AgentID == "" {
		flag.Usage()
		os.Exit(2)
	}

	NewAgent(cfg).Run()
}
