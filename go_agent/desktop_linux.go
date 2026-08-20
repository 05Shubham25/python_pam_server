//go:build linux

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
	return &execCapture{quality: clampQuality(quality)}, &xdotoolInput{}, nil
}

func checkStartupDependencies() {
	c := &execCapture{quality: 50}
	if err := c.Probe(); err != nil {
		fmt.Printf("\n======================================================================\n")
		fmt.Printf("[WARNING] Missing Linux Remote Desktop dependencies!\n\n")
		fmt.Printf("To enable Desktop streaming & mouse control, run this command:\n\n")
		fmt.Printf("  sudo apt-get update && sudo apt-get install -y gnome-screenshot xdotool\n\n")
		fmt.Printf("======================================================================\n\n")
	}
}

// execCapture captures JPEG frames via external tools:
//   - grim  : wlroots Wayland (sway / Hyprland / river), wlr-screencopy
//   - import: X11 / XWayland (ImageMagick)
//   - scrot : X11 fallback
type execCapture struct {
	quality   int
	tool      string // "grim" | "import" | "scrot"
	width     int
	height    int
	lastFrame []byte
}

func ensureX11Env() {
	if os.Getenv("DISPLAY") == "" {
		_ = os.Setenv("DISPLAY", ":0")
	}
	if os.Getenv("XAUTHORITY") == "" {
		if sudoUser := os.Getenv("SUDO_USER"); sudoUser != "" {
			_ = os.Setenv("XAUTHORITY", fmt.Sprintf("/home/%s/.Xauthority", sudoUser))
		}
	}
}

func runTool(tool string, quality int) ([]byte, error) {
	ensureX11Env()
	var cmd *exec.Cmd
	q := fmt.Sprintf("%d", quality)
	if tool == "gnome-screenshot" {
		cmd = exec.Command("gnome-screenshot", "-f", "/tmp/pam_frame.jpg")
	} else if tool == "grim" {
		cmd = exec.Command("grim", "-t", "jpeg", "-q", q, "-")
	} else if tool == "scrot" {
		cmd = exec.Command("scrot", "-q", q, "-o", "/tmp/pam_frame.jpg")
	} else {
		cmd = exec.Command("import", "-window", "root", "-quality", q, "jpeg:-")
	}
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s failed (DISPLAY=%s): %v (%s)", tool, os.Getenv("DISPLAY"), err, errOut.String())
	}
	if tool == "gnome-screenshot" || tool == "scrot" {
		data, err := os.ReadFile("/tmp/pam_frame.jpg")
		_ = os.Remove("/tmp/pam_frame.jpg")
		return data, err
	}
	if out.Len() == 0 {
		return nil, fmt.Errorf("%s produced no output", tool)
	}
	return out.Bytes(), nil
}

func toolAvailable(tool string) bool {
	_, err := exec.LookPath(tool)
	return err == nil
}

func (c *execCapture) probeTools() (bool, error) {
	var lastErr error
	if toolAvailable("gnome-screenshot") {
		if _, err := runTool("gnome-screenshot", 50); err == nil {
			c.tool = "gnome-screenshot"
			log.Printf("capture backend: gnome-screenshot (GNOME Wayland/X11)")
			return true, nil
		} else {
			lastErr = err
		}
	}
	if toolAvailable("grim") {
		if _, err := runTool("grim", 50); err == nil {
			c.tool = "grim"
			log.Printf("capture backend: grim (wlr-screencopy)")
			return true, nil
		} else {
			lastErr = err
		}
	}
	if toolAvailable("scrot") {
		if _, err := runTool("scrot", 50); err == nil {
			c.tool = "scrot"
			log.Printf("capture backend: scrot (X11)")
			return true, nil
		} else {
			lastErr = err
		}
	}
	if toolAvailable("import") {
		if _, err := runTool("import", 50); err == nil {
			c.tool = "import"
			log.Printf("capture backend: import (X11, ImageMagick)")
			return true, nil
		} else {
			lastErr = err
		}
	}
	return false, lastErr
}

func (c *execCapture) Probe() error {
	ok, err := c.probeTools()
	if ok {
		return nil
	}
	if err != nil {
		log.Printf("probe error details: %v", err)
	}
	if !toolAvailable("gnome-screenshot") && !toolAvailable("import") && !toolAvailable("grim") && !toolAvailable("scrot") {
		return fmt.Errorf("missing Linux desktop streaming dependencies!\n\nPlease install required packages on Linux:\n  Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y gnome-screenshot xdotool\n  Fedora/RHEL:   sudo dnf install -y gnome-screenshot xdotool\n  Arch Linux:    sudo pacman -S gnome-screenshot xdotool")
	}
	return fmt.Errorf("screen capture tool failed: %v — ensure a desktop GUI session is running (DISPLAY=%s)", err, os.Getenv("DISPLAY"))
}

func (c *execCapture) Open() error {
	frame, err := runTool(c.tool, c.quality)
	if err != nil {
		return err
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(frame))
	if err == nil {
		c.width, c.height = cfg.Width, cfg.Height
	}
	log.Printf("%s screen size: %dx%d", c.tool, c.width, c.height)
	return nil
}

func (c *execCapture) Size() (int, int) { return c.width, c.height }

func (c *execCapture) CaptureJPEG() ([]byte, error) {
	frame, err := runTool(c.tool, c.quality)
	if err != nil {
		return nil, err
	}
	if bytes.Equal(frame, c.lastFrame) {
		return nil, nil // unchanged screen
	}
	c.lastFrame = frame
	return frame, nil
}

func (c *execCapture) SetQuality(q int) { c.quality = clampQuality(q) }

func (c *execCapture) Close() {}

// xdotoolInput injects input events on X11 via xdotool.
type xdotoolInput struct {
	held []string // key combos currently down
}

func (x *xdotoolInput) Open() error {
	if !toolAvailable("xdotool") {
		return fmt.Errorf("xdotool not installed — run: sudo apt-get install -y xdotool")
	}
	return nil
}

func xdo(args ...string) {
	cmd := exec.Command("xdotool", args...)
	_ = cmd.Run()
}

func (x *xdotoolInput) ApplyEvent(ev inputEvent) {
	switch ev.T {
	case "mmove":
		xdo("mousemove", "--sync", fmt.Sprintf("%d", int(ev.X)), fmt.Sprintf("%d", int(ev.Y)))
	case "mdown":
		xdo("mousedown", fmt.Sprintf("%d", ev.B))
	case "mup":
		xdo("mouseup", fmt.Sprintf("%d", ev.B))
	case "mclick":
		xdo("mousemove", "--sync", fmt.Sprintf("%d", int(ev.X)), fmt.Sprintf("%d", int(ev.Y)))
		for i := 0; i < max(ev.Clk, 1); i++ {
			xdo("click", fmt.Sprintf("%d", ev.B))
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
		button := 4 // wheel up
		if clicks < 0 {
			button = 5
			clicks = -clicks
		}
		for i := 0; i < clicks; i++ {
			xdo("click", fmt.Sprintf("%d", button))
		}
	case "key":
		down := ev.Down == nil || *ev.Down
		combo := xdotoolCombo(ev.Key, ev.Mod)
		if combo == "" {
			return
		}
		if down {
			xdo("keydown", combo)
			x.held = append(x.held, combo)
		} else {
			xdo("keyup", combo)
			x.removeHeld(combo)
		}
	}
}

func (x *xdotoolInput) removeHeld(combo string) {
	for i, h := range x.held {
		if h == combo {
			x.held = append(x.held[:i], x.held[i+1:]...)
			return
		}
	}
}

func (x *xdotoolInput) ReleaseAll() {
	for _, combo := range x.held {
		xdo("keyup", combo)
	}
	x.held = nil
}

func (x *xdotoolInput) Close() { x.ReleaseAll() }

func xdotoolCombo(key string, mods []string) string {
	var parts []string
	for _, m := range mods {
		switch m {
		case "ctrl", "control":
			parts = append(parts, "ctrl")
		case "alt":
			parts = append(parts, "alt")
		case "shift":
			parts = append(parts, "shift")
		case "meta", "os", "cmd", "super":
			parts = append(parts, "super")
		}
	}
	if k := xdotoolKey(key); k != "" {
		parts = append(parts, k)
	}
	if len(parts) == 0 {
		return ""
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += "+" + p
	}
	return out
}

func xdotoolKey(key string) string {
	special := map[string]string{
		"enter": "Return", "return": "Return",
		"backspace": "BackSpace", "tab": "Tab",
		"escape": "Escape", "esc": "Escape",
		"delete": "Delete", "insert": "Insert",
		"home": "Home", "end": "End",
		"pageup": "Page_Up", "page_up": "Page_Up",
		"pagedown": "Page_Down", "page_down": "Page_Down",
		"capslock": "Caps_Lock", "space": "space",
		"arrowup": "Up", "up": "Up",
		"arrowdown": "Down", "down": "Down",
		"arrowleft": "Left", "left": "Left",
		"arrowright": "Right", "right": "Right",
		"printscreen": "Print", "print_screen": "Print",
	}
	lower := lowerKey(key)
	if k, ok := special[lower]; ok {
		return k
	}
	if fn, ok := fnKeyNumber(lower); ok {
		return "F" + fn
	}
	if len(key) == 1 {
		return lower
	}
	return ""
}
