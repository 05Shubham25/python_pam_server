# PAM Agent

Connects a machine to the PAM control plane. Handles **terminal sessions**
(real PTY on POSIX, pipes on Windows) and **desktop sessions** (screen capture
streamed as JPEG frames + mouse/keyboard injection).

## Architecture

```
Browser                                Client machine
┌─────────────────────────┐            ┌─────────────────────────────────┐
│ SSH:  xterm.js          │            │ pam_agent.py (asyncio)          │
│ RDP:  <canvas> + events │            │                                 │
└───────┬─────────────────┘            │  control loop                   │
        │ WS  /ws/browser/{session}    │   heartbeat   → host online     │
┌───────┴─────────────────┐   Redis    │   poll sessions → spawn workers │
│ FastAPI broker          │   streams  │  ┌───────────────────────────┐ │
│ (verbatim byte relay —  │◄──────────►│  │ TerminalWorker: PTY ⇄ WS  │ │
│  no changes needed)     │            │  │ DesktopWorker:            │ │
└─────────────────────────┘            │  │   mss → JPEG → WS         │ │
                                       │  │   WS JSON → pynput input  │ │
        ▲                              │  └───────────────────────────┘ │
        │                              │  every worker: isolated task,  │
        └─ WS /ws/agent/{agent_id} ────┘  bounded queues, clean kills   │
```

The broker never inspects payloads, so the agent and browser share a tiny
frame protocol on top of the binary pipe (first byte of every frame):

| Tag  | Direction      | Payload                                    |
|------|----------------|--------------------------------------------|
| 0x01 | both           | terminal bytes                             |
| 0x02 | both           | JSON control (see below)                   |
| 0x03 | agent → browser| full-frame JPEG (desktop)                  |

Control messages (`0x02`):
- browser → agent: `resize {cols,rows}` · `mmove/mdown/mup/mclick {x,y,b,clk}` ·
  `mwheel {dy}` · `key {key,mod[],down}` · `quality {q}`
- agent → browser: `hello {mode,width,height}` · `bye {reason}`

Because frames transit Redis streams, a session survives an agent restart:
keystrokes sent while the agent reconnects are replayed from the stream.

## Install & run

```bash
pip install -r requirements.txt          # websockets only = terminal mode
python pam_agent.py --server http://<server>:8000 --agent-id agt_XXXX
```

Register the host in the UI first (Hosts → Register Host) with a matching
agent id, or via `POST /api/v1/hosts`. The host shows **online** once
heartbeats arrive, and flips **offline** automatically ~45s after they stop.

Useful flags: `--fps 10 --quality 60` (desktop stream), `--monitor 1`,
`--max-sessions 5`, `--no-desktop`, `--no-terminal`, `--verbose`.

## Platform notes

| OS      | Terminal              | Desktop                        | Permissions / gotchas                          |
|---------|-----------------------|--------------------------------|-------------------------------------------------|
| Linux   | real PTY              | X11: mss · **Wayland: xdg-desktop-portal + PipeWire** | see Wayland section below |
| Windows | cmd.exe over pipes    | mss (GDI) + pynput             | run in the interactive session, not a session-0 service; ConPTY upgrade optional |
| macOS   | real PTY              | mss + pynput                   | grant the interpreter **Screen Recording** + **Accessibility** in Privacy & Security |

### Wayland desktop capture (Linux)

X11 screen grabs see a black XWayland root window under Wayland, so the agent
auto-selects a **portal-based capture** (`wayland_capture.py`) when it detects
a Wayland session (`XDG_SESSION_TYPE=wayland` or `$WAYLAND_DISPLAY` set) —
the same D-Bus → PipeWire → GStreamer path OBS and Zoom use.

Behavior: the **first** desktop session shows a compositor consent dialog
("Share your screen?") on the client machine — click Allow once. The grant is
persisted (`~/.pam_agent/wayland_restore_token.json`) and replayed on every
later run, so subsequent sessions are fully unattended on GNOME 42+ and KDE
Plasma 5.27+. On sway/wlroots portals (xdg-desktop-portal-wlr) the restore
token is unsupported — expect the dialog on every session. Input injection
(pynput/XTest) works on GNOME/KDE Wayland; it does **not** work on sway.

One-time setup on the client machine:

```bash
sudo apt install python3-gi gir1.2-gstreamer-1.0 \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-pipewire xdg-desktop-portal-gnome   # or -kde / -wlr
pip install dbus-next
```

**venv caveat:** `python3-gi` installs into the *system* Python. If the agent
runs inside a venv, `import gi` fails there — recreate the venv with
`python3 -m venv --system-site-packages env` (or `pip install PyGObject`
inside the venv after installing `libgirepository1.0-dev`).

Deploy note: the agent now ships as **two files** — copy both `pam_agent.py`
and `wayland_capture.py` to the client machine (the latter is a no-op import
on Windows/macOS/X11).

## Resource safety (why it won't hang the machine or server)

- **Isolation** — each session is one supervised asyncio task; any crash is
  logged and contained. The control loop outlives every worker.
- **Bounded queues** — desktop frames flow through a drop-oldest queue of 2:
  a slow network lowers fps instead of growing memory or blocking capture.
- **Frame skipping** — unchanged screens are detected and never encoded/sent.
- **Capped rates** — capture ≤ `--fps`, input events rate-limited by design.
- **Clean child kill** — shells run in their own process group, SIGTERM →
  3s grace → SIGKILL; no orphan shells survive a disconnect.
- **WS keepalive** — ping 20s / timeout 10s kills dead TCP peers instead of
  leaking tasks; receive buffers capped (`max_queue`, `max_size`).
- **Reconnect** — heartbeat retries with capped exponential backoff + jitter.
- **Global cap** — `--max-sessions` refuses extra concurrent sessions.

## Security status (be aware)

Agent WebSocket and agent endpoints are currently **unauthenticated** —
anyone who knows an agent id can connect as that host. Fine on a trusted lab
network; before real use, add a per-agent token (query header on the WS +
check in `broker_ws.py`) and TLS on both HTTP and WS.

## Recording (roadmap — not built yet)

Terminal output already flows through Redis as hex frames in
`session:{id}:output` — a recorder worker can consume that stream with a
separate consumer group and write asciinema casts without touching the live
path. Desktop sessions can be recorded the same way (append JPEG frames with
timestamps), or encoded browser-side via `MediaRecorder` on the canvas.
