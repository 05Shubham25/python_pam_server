//go:build linux

package main

import (
	"bytes"
	"fmt"
	"image"
	_ "image/jpeg"
	"log"
	"os/exec"
)

func NewDesktopBackends(monitor, quality int) (CaptureBackend, InputBackend, error) {
	return &execCapture{quality: clampQuality(quality)}, &xdotoolInput{}, nil
}

// execCapture captures JPEG frames via external tools:
//   - grim  : wlroots Wayland (sway / Hyprland / river), wlr-screencopy
//   - import: X11 / XWayland (ImageMagick)
// Both write JPEG straight to stdout, so frames pass through unencoded.
type execCapture struct {
	quality   int
	tool      string // "grim" | "import"
	width     int
	height    int
	lastFrame []byte
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

func runTool(tool string, quality int) ([]byte, error) {
	var cmd *exec.Cmd
	q := fmt.Sprintf("%d", quality)
	if tool == "grim" {
		cmd = exec.Command("grim", "-t", "jpeg", "-q", q, "-")
	} else {
		cmd = exec.Command("import", "-window", "root", "-quality", q, "jpeg:-")
	}
	var out, errOut bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s failed: %v: %s", tool, err, errOut.String())
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

func (c *execCapture) Probe() error {
	switch {
	case toolAvailable("grim"):
		if _, err := runTool("grim", 50); err == nil {
			c.tool = "grim"
			log.Printf("capture backend: grim (wlr-screencopy)")
			return nil
		}
		fallthrough
	case toolAvailable("import"):
		if _, err := runTool("import", 50); err == nil {
			c.tool = "import"
			log.Printf("capture backend: import (X11, ImageMagick)")
			return nil
		}
		return fmt.Errorf("no capture backend available — install grim (wlroots Wayland) or imagemagick (X11)")
	default:
		return fmt.Errorf("no capture backend available — install grim (wlroots Wayland) or imagemagick (X11)")
	}
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
		return fmt.Errorf("xdotool not installed — input injection disabled (capture still works)")
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
