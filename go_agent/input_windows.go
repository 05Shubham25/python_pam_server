//go:build windows

package main

import (
	"unsafe"
)

var (
	pSendInput    = user32.NewProc("SendInput")
	pSetCursorPos = user32.NewProc("SetCursorPos")
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseEventFMove        = 0x0001
	mouseEventFLeftDown    = 0x0002
	mouseEventFLeftUp      = 0x0004
	mouseEventFRightDown   = 0x0008
	mouseEventFRightUp     = 0x0010
	mouseEventFMiddleDown  = 0x0020
	mouseEventFMiddleUp    = 0x0040
	mouseEventFWheel       = 0x0800
	mouseEventFAbsolute    = 0x8000
	mouseEventFVirtualDesk = 0x4000

	keyEventFKeyUp = 0x0002
)

type mouseInput struct {
	dx          int32
	dy          int32
	mouseData   uint32
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type keybdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type winInputStruct struct {
	inputType uint32
	_padding  uint32 // 64-bit alignment
	data      [32]byte
}

type winInput struct {
	held []string
}

func (w *winInput) Open() error { return nil }

func sendMouseInput(flags uint32, dx, dy int32, data uint32) {
	width, height := screenSize()
	if width <= 0 || height <= 0 {
		return
	}
	pSetCursorPos.Call(uintptr(dx), uintptr(dy))

	nx := (int(dx) * 65535) / width
	ny := (int(dy) * 65535) / height

	var inp winInputStruct
	inp.inputType = inputMouse
	mi := (*mouseInput)(unsafe.Pointer(&inp.data[0]))
	mi.dx = int32(nx)
	mi.dy = int32(ny)
	mi.mouseData = data
	mi.dwFlags = flags | mouseEventFMove | mouseEventFAbsolute | mouseEventFVirtualDesk

	pSendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
}

func sendKeybdInput(vk uint16, flags uint32) {
	var inp winInputStruct
	inp.inputType = inputKeyboard
	ki := (*keybdInput)(unsafe.Pointer(&inp.data[0]))
	ki.wVk = vk
	ki.dwFlags = flags

	pSendInput.Call(1, uintptr(unsafe.Pointer(&inp)), unsafe.Sizeof(inp))
}

func (w *winInput) ApplyEvent(ev inputEvent) {
	switch ev.T {
	case "mmove":
		sendMouseInput(mouseEventFMove, int32(ev.X), int32(ev.Y), 0)
	case "mdown":
		sendMouseInput(mouseEventFMove, int32(ev.X), int32(ev.Y), 0)
		if flag, ok := buttonDownFlag(ev.B); ok {
			sendMouseInput(flag, int32(ev.X), int32(ev.Y), 0)
		}
	case "mup":
		sendMouseInput(mouseEventFMove, int32(ev.X), int32(ev.Y), 0)
		if flag, ok := buttonUpFlag(ev.B); ok {
			sendMouseInput(flag, int32(ev.X), int32(ev.Y), 0)
		}
	case "mclick":
		sendMouseInput(mouseEventFMove, int32(ev.X), int32(ev.Y), 0)
		down, _ := buttonDownFlag(ev.B)
		up, _ := buttonUpFlag(ev.B)
		for i := 0; i < max(ev.Clk, 1); i++ {
			if down != 0 {
				sendMouseInput(down, int32(ev.X), int32(ev.Y), 0)
			}
			if up != 0 {
				sendMouseInput(up, int32(ev.X), int32(ev.Y), 0)
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
		sendMouseInput(mouseEventFWheel, 0, 0, uint32(clicks*120))
	case "key":
		down := ev.Down == nil || *ev.Down
		vk := windowsVK(ev.Key)
		if vk == 0 {
			return
		}
		if down {
			sendKeybdInput(vk, 0)
			w.held = append(w.held, ev.Key)
		} else {
			sendKeybdInput(vk, keyEventFKeyUp)
			w.removeHeld(ev.Key)
		}
	}
}

func buttonDownFlag(b int) (uint32, bool) {
	switch b {
	case 1:
		return mouseEventFLeftDown, true
	case 2:
		return mouseEventFMiddleDown, true
	case 3:
		return mouseEventFRightDown, true
	}
	return 0, false
}

func buttonUpFlag(b int) (uint32, bool) {
	switch b {
	case 1:
		return mouseEventFLeftUp, true
	case 2:
		return mouseEventFMiddleUp, true
	case 3:
		return mouseEventFRightUp, true
	}
	return 0, false
}

func (w *winInput) removeHeld(key string) {
	for i, h := range w.held {
		if h == key {
			w.held = append(w.held[:i], w.held[i+1:]...)
			return
		}
	}
}

func (w *winInput) ReleaseAll() {
	for _, key := range w.held {
		if vk := windowsVK(key); vk != 0 {
			sendKeybdInput(vk, keyEventFKeyUp)
		}
	}
	w.held = nil
}

func (w *winInput) Close() { w.ReleaseAll() }

func windowsVK(key string) uint16 {
	special := map[string]uint16{
		"enter": 0x0D, "return": 0x0D,
		"backspace": 0x08, "tab": 0x09,
		"escape": 0x1B, "esc": 0x1B,
		"delete": 0x2E, "insert": 0x2D,
		"home": 0x24, "end": 0x23,
		"pageup": 0x21, "page_up": 0x21,
		"pagedown": 0x22, "page_down": 0x22,
		"capslock": 0x14, "space": 0x20,
		"arrowup": 0x26, "up": 0x26,
		"arrowdown": 0x28, "down": 0x28,
		"arrowleft": 0x25, "left": 0x25,
		"arrowright": 0x27, "right": 0x27,
		"printscreen": 0x2C, "print_screen": 0x2C,
	}
	lower := lowerKey(key)
	if vk, ok := special[lower]; ok {
		return vk
	}
	if fn, ok := fnKeyNumber(lower); ok {
		n := 0
		for _, c := range fn {
			n = n*10 + int(c-'0')
		}
		return uint16(0x70 + n - 1) // VK_F1..VK_F12
	}
	if len(key) == 1 {
		c := key[0]
		if c >= 'a' && c <= 'z' {
			return uint16('A' + c - 'a')
		}
		if c >= 'A' && c <= 'Z' {
			return uint16(c)
		}
		if c >= '0' && c <= '9' {
			return uint16(c)
		}
		return 0
	}
	return 0
}
