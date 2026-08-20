//go:build !windows

package main

import (
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// PTYShell runs the user's shell on a real pseudo-terminal.
type PTYShell struct {
	cols, rows int
	ptmx       *os.File
	cmd        *exec.Cmd
	mu         sync.Mutex
}

func NewShell(cols, rows int) (Shell, error) {
	return &PTYShell{cols: cols, rows: rows}, nil
}

func (s *PTYShell) Start() error {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell, "-i")
	cmd.Env = os.Environ()
	// own session -> the whole process group dies with the session
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	size := &pty.Winsize{Rows: uint16(s.rows), Cols: uint16(s.cols)}
	ptmx, err := pty.StartWithSize(cmd, size)
	if err != nil {
		return err
	}
	s.ptmx = ptmx
	s.cmd = cmd
	return nil
}

func (s *PTYShell) Read(buf []byte) (int, error) { return s.ptmx.Read(buf) }

func (s *PTYShell) Write(b []byte) error {
	_, err := s.ptmx.Write(b)
	return err
}

func (s *PTYShell) Resize(cols, rows int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cols, s.rows = cols, rows
	if s.ptmx != nil {
		_ = pty.Setsize(s.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	}
}

func (s *PTYShell) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil {
		// negative pid = whole process group (we setsid'd at start)
		_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGTERM)
		done := make(chan struct{})
		go func() { _, _ = s.cmd.Process.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
		}
	}
	if s.ptmx != nil {
		s.ptmx.Close()
		s.ptmx = nil
	}
}

func (s *PTYShell) ManualEcho() bool { return false }
