package main

// Frame protocol over the broker's binary WebSocket (first byte).
// Must stay in sync with agent/pam_agent.py and the frontend terminal view.
const (
	TAG_TTY  = 0x01 // terminal bytes, both directions
	TAG_CTRL = 0x02 // JSON control message, both directions
	TAG_JPEG = 0x03 // full-frame JPEG, agent -> browser
)

const (
	AgentVersion       = "0.5.0-go"
	HeartbeatInterval  = 10 // seconds
	PollInterval       = 2  // seconds
	AttachRetrySeconds = 5  // min seconds between attach attempts per session
)
