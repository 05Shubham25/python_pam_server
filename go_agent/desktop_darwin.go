//go:build darwin

package main

import (
	"bytes"
	"fmt"
	"image"
	_ "image/jpeg"
	"log"
	"os"
	"os/exec"
)

func NewDesktopBackends(monitor, quality int) (CaptureBackend, InputBackend, error) {
	return &screencaptureBackend{quality: clampQuality(quality)}, &cliclickInput{}, nil
}

func checkStartupDependencies() {}

// screencaptureBackend uses the built-in `screencapture` CLI, which writes
// to a file (no stdout mode), so frames go through a temp file.
type screencaptureBackend struct {
	quality   int
	width     int
	height    int
	lastFrame []byte
}

func (s *screencaptureBackend) Probe() error {
	if _, err := exec.LookPath("screencapture"); err != nil {
		return fmt.Errorf("screencapture not found")
	}
	log.Printf("capture backend: screencapture (CoreGraphics)")
	return nil
}

func (s *screencaptureBackend) Open() error { return nil }

func (s *screencaptureBackend) Size() (int, int) {
	frame, err := s.grab()
	if err != nil {
		return s.width, s.height
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(frame)); err == nil {
		s.width, s.height = cfg.Width, cfg.Height
	}
	return s.width, s.height
}

func (s *screencaptureBackend) grab() ([]byte, error) {
	tmp, err := os.CreateTemp("", "pam-frame-*.jpg")
	if err != nil {
		return nil, err
	}
	name := tmp.Name()
	tmp.Close()
	defer os.Remove(name)
	if err := exec.Command("screencapture", "-x", "-t", "jpg", name).Run(); err != nil {
		return nil, fmt.Errorf("screencapture failed: %w", err)
	}
	return os.ReadFile(name)
}

func (s *screencaptureBackend) CaptureJPEG() ([]byte, error) {
	frame, err := s.grab()
	if err != nil {
		return nil, err
	}
	if bytes.Equal(frame, s.lastFrame) {
		return nil, nil
	}
	s.lastFrame = frame
	return frame, nil
}

func (s *screencaptureBackend) SetQuality(q int) { s.quality = clampQuality(q) }

func (s *screencaptureBackend) Close() {}

// cliclickInput injects input via the cliclick CLI (brew install cliclick).
type cliclickInput struct {
	held []string
}

func (c *cliclickInput) Open() error {
	if _, err := exec.LookPath("cliclick"); err != nil {
		return fmt.Errorf("cliclick not installed — input injection disabled (brew install cliclick)")
	}
	return nil
}

func cliclick(args ...string) {
	_ = exec.Command("cliclick", args...).Run()
}

func (c *cliclickInput) ApplyEvent(ev inputEvent) {
	switch ev.T {
	case "mmove":
		cliclick(fmt.Sprintf("m:%d,%d", int(ev.X), int(ev.Y)))
	case "mdown":
		button := mouseButtonArg(ev.B, "down")
		if button != "" {
			cliclick(button)
		}
	case "mup":
		button := mouseButtonArg(ev.B, "up")
		if button != "" {
			cliclick(button)
		}
	case "mclick":
		cliclick(fmt.Sprintf("m:%d,%d", int(ev.X), int(ev.Y)))
		button := mouseButtonArg(ev.B, "c")
		if button != "" {
			for i := 0; i < max(ev.Clk, 1); i++ {
				cliclick(button)
			}
		}
	case "mwheel":
		clicks := int(ev.Dy / 100)
		if clicks > 5 {
			clicks = 5
		}
		if clicks < -5 {
			clicks = -5
		}
		if clicks == 0 {
			return
		}
		if clicks > 0 {
			cliclick(fmt.Sprintf("w:0,%d", clicks))
		} else {
			cliclick(fmt.Sprintf("w:0,%d", clicks))
		}
	case "key":
		down := ev.Down == nil || *ev.Down
		key := darwinKey(ev.Key)
		if key == "" {
			return
		}
		if down {
			cliclick("kd:"+darwinModsCombo(ev.Mod, key))
			c.held = append(c.held, key)
		} else {
			cliclick("ku:"+darwinModsCombo(ev.Mod, key))
			c.removeHeld(key)
		}
	}
}

func mouseButtonArg(b int, action string) string {
	switch b {
	case 1:
		return "left" + action
	case 2:
		return "middle" + action
	case 3:
		return "right" + action
	}
	return ""
}

func (c *cliclickInput) removeHeld(key string) {
	for i, h := range c.held {
		if h == key {
			c.held = append(c.held[:i], c.held[i+1:]...)
			return
		}
	}
}

func (c *cliclickInput) ReleaseAll() {
	for _, key := range c.held {
		cliclick("ku:" + key)
	}
	c.held = nil
}

func (c *cliclickInput) Close() { c.ReleaseAll() }

func darwinModsCombo(mods []string, key string) string {
	out := ""
	for _, m := range mods {
		switch m {
		case "ctrl", "control":
			out += "ctrl-"
		case "alt":
			out += "alt-"
		case "shift":
			out += "shift-"
		case "meta", "os", "cmd", "super":
			out += "cmd-"
		}
	}
	return out + key
}

func darwinKey(key string) string {
	special := map[string]string{
		"enter": "return", "return": "return",
		"backspace": "delete", "tab": "tab",
		"escape": "esc", "esc": "esc",
		"delete": "forward-delete", "insert": "help",
		"home": "home", "end": "end",
		"pageup": "pageup", "page_up": "pageup",
		"pagedown": "pagedown", "page_down": "pagedown",
		"space": "space",
		"arrowup": "up", "up": "up",
		"arrowdown": "down", "down": "down",
		"arrowleft": "left", "left": "left",
		"arrowright": "right", "right": "right",
	}
	lower := lowerKey(key)
	if k, ok := special[lower]; ok {
		return k
	}
	if fn, ok := fnKeyNumber(lower); ok {
		return "f" + fn
	}
	if len(key) == 1 {
		return lower
	}
	return ""
}
