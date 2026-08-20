package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// SessionInfo mirrors one row of GET /api/v1/agent/sessions.
type SessionInfo struct {
	ID          string `json:"id"`
	HostID      string `json:"host_id"`
	SessionType string `json:"session_type"` // "ssh" | "rdp"
	Status      string `json:"status"`
}

// ControlClient is the agent-facing HTTP + WebSocket client.
type ControlClient struct {
	Server  string // base URL, no trailing slash
	AgentID string
	WSBase  string
	Client  *http.Client
	Dialer  *websocket.Dialer
}

func NewControlClient(server, agentID string) *ControlClient {
	server = strings.TrimRight(server, "/")
	wsBase := strings.Replace(server, "http://", "ws://", 1)
	wsBase = strings.Replace(wsBase, "https://", "wss://", 1)
	return &ControlClient{
		Server:  server,
		AgentID: agentID,
		WSBase:  wsBase,
		Client:  &http.Client{Timeout: 8 * time.Second},
		Dialer:  &websocket.Dialer{HandshakeTimeout: 10 * time.Second},
	}
}

func (c *ControlClient) request(path, method string, body map[string]string) (map[string]any, error) {
	var rdr io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.Server+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connection: %w", err)
	}
	defer res.Body.Close()
	payload, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &out); err != nil {
			return nil, fmt.Errorf("bad json from server: %w", err)
		}
	}
	return out, nil
}

// Heartbeat marks the host online. Returns the server's JSON, where
// ok=false means the agent_id is not registered yet.
func (c *ControlClient) Heartbeat() (map[string]any, error) {
	return c.request("/api/v1/agent/heartbeat", "POST", map[string]string{"agent_id": c.AgentID})
}

// Offline is the best-effort final call on shutdown.
func (c *ControlClient) Offline() {
	_, _ = c.request("/api/v1/agent/offline", "POST", map[string]string{"agent_id": c.AgentID})
}

// ActiveSessions lists sessions on this host that a browser is waiting on.
func (c *ControlClient) ActiveSessions() ([]SessionInfo, error) {
	res, err := c.request("/api/v1/agent/sessions?agent_id="+c.AgentID, "GET", nil)
	if err != nil {
		return nil, err
	}
	var sessions []SessionInfo
	raw, _ := json.Marshal(res["sessions"])
	if err := json.Unmarshal(raw, &sessions); err != nil {
		return nil, err
	}
	return sessions, nil
}

// SessionWS dials the broker and binds it to a session by sending the
// session id as the first text message.
func (c *ControlClient) SessionWS(sessionID string) (*websocket.Conn, error) {
	url := fmt.Sprintf("%s/api/v1/ws/agent/%s", c.WSBase, c.AgentID)
	conn, _, err := c.Dialer.Dial(url, nil)
	if err != nil {
		return nil, err
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(sessionID)); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}
