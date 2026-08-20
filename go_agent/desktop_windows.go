//go:build windows

package main

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"log"
	"sync"
	"syscall"
	"unsafe"
)

func NewDesktopBackends(monitor, quality int) (CaptureBackend, InputBackend, error) {
	return &gdiCapture{quality: clampQuality(quality)}, &winInput{}, nil
}

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	gdi32           = syscall.NewLazyDLL("gdi32.dll")
	pGetDC          = user32.NewProc("GetDC")
	pReleaseDC      = user32.NewProc("ReleaseDC")
	pGetDesktopWnd  = user32.NewProc("GetDesktopWindow")
	pCreateCompatDC = gdi32.NewProc("CreateCompatibleDC")
	pDeleteDC       = gdi32.NewProc("DeleteDC")
	pCreateCompatBM = gdi32.NewProc("CreateCompatibleBitmap")
	pDeleteObject   = gdi32.NewProc("DeleteObject")
	pSelectObject   = gdi32.NewProc("SelectObject")
	pBitBlt         = gdi32.NewProc("BitBlt")
	pGetDIBits      = gdi32.NewProc("GetDIBits")
	pGetSysMetrics  = user32.NewProc("GetSystemMetrics")
)

const (
	smCxFn  = 0  // SM_CXSCREEN
	smCyFn  = 1  // SM_CYSCREEN
	srccopy = 0x00CC0020
)

type bmiHeader struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

// gdiCapture grabs the primary screen via GDI BitBlt — pure syscalls, no cgo.
type gdiCapture struct {
	quality   int
	width     int
	height    int
	lastFrame []byte
	mu        sync.Mutex

	deskWnd uintptr
	hdc     uintptr
	memDC   uintptr
	bmp     uintptr
	oldBmp  uintptr
	rawBuf  []byte
}

func (g *gdiCapture) Probe() error {
	w, h := screenSize()
	if w == 0 || h == 0 {
		return fmt.Errorf("no display detected")
	}
	g.width, g.height = w, h
	log.Printf("capture backend: Windows GDI (%dx%d)", w, h)
	return nil
}

func (g *gdiCapture) Open() error { return nil }

func screenSize() (int, int) {
	w, _, _ := pGetSysMetrics.Call(smCxFn)
	h, _, _ := pGetSysMetrics.Call(smCyFn)
	return int(w), int(h)
}

func (g *gdiCapture) Size() (int, int) {
	g.width, g.height = screenSize()
	return g.width, g.height
}

func (g *gdiCapture) initGDI(width, height int) error {
	g.cleanupGDI()

	g.deskWnd, _, _ = pGetDesktopWnd.Call()
	g.hdc, _, _ = pGetDC.Call(g.deskWnd)
	if g.hdc == 0 {
		return fmt.Errorf("GetDC failed")
	}

	g.memDC, _, _ = pCreateCompatDC.Call(g.hdc)
	if g.memDC == 0 {
		g.cleanupGDI()
		return fmt.Errorf("CreateCompatibleDC failed")
	}

	g.bmp, _, _ = pCreateCompatBM.Call(g.hdc, uintptr(width), uintptr(height))
	if g.bmp == 0 {
		g.cleanupGDI()
		return fmt.Errorf("CreateCompatibleBitmap failed")
	}

	g.oldBmp, _, _ = pSelectObject.Call(g.memDC, g.bmp)
	g.width = width
	g.height = height
	g.rawBuf = make([]byte, width*height*4)
	return nil
}

func (g *gdiCapture) cleanupGDI() {
	if g.memDC != 0 && g.oldBmp != 0 {
		pSelectObject.Call(g.memDC, g.oldBmp)
		g.oldBmp = 0
	}
	if g.bmp != 0 {
		pDeleteObject.Call(g.bmp)
		g.bmp = 0
	}
	if g.memDC != 0 {
		pDeleteDC.Call(g.memDC)
		g.memDC = 0
	}
	if g.hdc != 0 {
		pReleaseDC.Call(g.deskWnd, g.hdc)
		g.hdc = 0
	}
}

func (g *gdiCapture) CaptureJPEG() ([]byte, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	width, height := screenSize()
	if width == 0 || height == 0 {
		return nil, fmt.Errorf("invalid screen size")
	}

	if g.memDC == 0 || g.width != width || g.height != height {
		if err := g.initGDI(width, height); err != nil {
			return nil, err
		}
	}

	ret, _, _ := pBitBlt.Call(g.memDC, 0, 0, uintptr(width), uintptr(height),
		g.hdc, 0, 0, srccopy)
	if ret == 0 {
		g.cleanupGDI()
		return nil, fmt.Errorf("BitBlt failed")
	}

	header := bmiHeader{
		BiSize:        uint32(unsafe.Sizeof(bmiHeader{})),
		BiWidth:       int32(width),
		BiHeight:      -int32(height), // negative = top-down rows
		BiPlanes:      1,
		BiBitCount:    32,
		BiCompression: 0, // BI_RGB
	}
	ret, _, _ = pGetDIBits.Call(g.hdc, g.bmp, 0, uintptr(height),
		uintptr(unsafe.Pointer(&g.rawBuf[0])), uintptr(unsafe.Pointer(&header)), 0)
	if ret == 0 {
		g.cleanupGDI()
		return nil, fmt.Errorf("GetDIBits failed")
	}

	// BGRA -> RGBA; JPEG ignores the alpha channel.
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < width*height; i++ {
		off := i * 4
		img.Pix[off] = g.rawBuf[off+2]   // R
		img.Pix[off+1] = g.rawBuf[off+1] // G
		img.Pix[off+2] = g.rawBuf[off]   // B
		img.Pix[off+3] = 0xFF
	}

	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: g.quality}); err != nil {
		return nil, err
	}
	frame := buf.Bytes()
	if bytes.Equal(frame, g.lastFrame) {
		return nil, nil
	}
	g.lastFrame = frame
	return frame, nil
}

func (g *gdiCapture) SetQuality(q int) { g.quality = clampQuality(q) }

func (g *gdiCapture) Close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.cleanupGDI()
}
