//go:build windows

package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
)

// PipeShell runs cmd.exe over stdin/stdout pipes. No kernel echo, no ANSI
// line discipline — the terminal worker shims echo and CR translation.
type PipeShell struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	out io.ReadCloser
	mu  sync.Mutex
}

func NewShell(cols, rows int) (Shell, error) {
	_ = cols
	_ = rows
	return &PipeShell{}, nil
}

func (s *PipeShell) Start() error {
	cmdPath := os.Getenv("COMSPEC")
	if cmdPath == "" {
		cmdPath = "cmd.exe"
	}
	cmd := exec.Command(cmdPath)
	cmd.Env = os.Environ()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout // merge into the same pipe
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", cmdPath, err)
	}
	s.cmd = cmd
	s.in = stdin
	s.out = stdout
	return nil
}

func (s *PipeShell) Read(buf []byte) (int, error) {
	n, err := s.out.Read(buf)
	if err == io.EOF {
		return 0, io.EOF
	}
	return n, err
}

func (s *PipeShell) Write(b []byte) error {
	_, err := s.in.Write(b)
	return err
}

func (s *PipeShell) Resize(cols, rows int) {
	// pipe shells have no tty size to update
}

func (s *PipeShell) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.in != nil {
		s.in.Close()
		s.in = nil
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_, _ = s.cmd.Process.Wait()
		s.cmd = nil
	}
}

func (s *PipeShell) ManualEcho() bool { return true }
