# RDP-Style Desktop Sessions — Complete Architecture Guide

This document explains everything about desktop ("Screen" / `rdp`) sessions in
the PAM control plane: how a session works end-to-end, the architecture, every
module involved, and a full diagnostic guide for the classic
**"black screen but mouse control works"** failure — including every cause we
hit in practice and how each was identified.

> **Naming note:** session type `rdp` in the database is *RDP-style access*
> (remote display + input control in the browser), not the Microsoft RDP
> protocol. Under the hood it is a JPEG frame stream + JSON input events over
> the same broker used for SSH terminals — closer to "VNC in your browser".

---

## 1. Big Picture

```
┌────────────────────────────┐
│ Browser (Next.js page)     │
│  DesktopView.tsx           │
│   <canvas> renders JPEGs   │
│   mouse/key events → JSON  │
└──────┬─────────────────────┘
       │ WebSocket (binary, tagged frames)
       │ /api/v1/ws/browser/{session_id}
┌──────┴─────────────────────┐
│ FastAPI broker             │   app/api/v1/endpoints/broker_ws.py
│ (dumb byte relay — never   │
│  inspects payloads)        │
└──────┬─────────────────────┘
       │ Redis Streams (hex-encoded)
       │   session:{id}:input   browser → agent
       │   session:{id}:output  agent  → browser
└──────┬─────────────────────┘
       │ WebSocket (binary, tagged frames)
       │ /api/v1/ws/agent/{agent_id}
┌──────┴─────────────────────┐
│ pam_agent.py (client box)  │
│  DesktopWorker             │
│   capture: mss → JPEG      │
│   input:   pynput inject   │
└──────┬─────────────────────┘
       │ OS APIs
┌──────┴─────────────────────┐
│ Real desktop (X11 / Win32  │
│ GDI / macOS CGDisplay)     │
└────────────────────────────┘

Control plane (HTTP, not shown above):
  agent ──POST /agent/heartbeat──────────► host marked online (45s freshness)
  agent ──GET  /agent/sessions───────────► active sessions with a live browser
  user  ──POST /sessions─────────────────► session created (status=active)
  user  ──POST /sessions/{id}/terminate──► session closed, workers wind down
```

**Why a broker in the middle?** The browser and agent never talk directly
(NAT/firewalls), the server never decrypts/inspects session bytes, Redis
streams give backpressure buffering, and — because streams persist — a session
survives an agent reconnect: keystrokes sent while the agent is down are
replayed from the stream when it reattaches. It is also exactly where a
recorder will tap in later (second consumer group on the output stream).

---

## 2. Session Lifecycle, Step by Step

### 2.1 Host registration (one-time)
`POST /api/v1/hosts` stores hostname, IP, OS, environment and a unique
**agent_id** (e.g. `agt_1234`). A host row is just an identity; nothing runs
until an agent claims that id.

### 2.2 Agent comes online
The agent heartbeats every **10 s** (`POST /api/v1/agent/heartbeat`). The
endpoint sets `is_online = true` and stamps `updated_at`. `GET /api/v1/hosts`
reports a host online **only if** `is_online AND updated_at within 45 s` — so a
crashed or network-partitioned agent flips to offline automatically with no
sweeper process needed. On clean shutdown the agent also calls
`POST /agent/offline`.

### 2.3 User clicks "Screen"
1. Frontend `POST /api/v1/sessions {host_id, session_type: "rdp"}`.
2. Backend verifies the host exists **and is online** (404
   "Host agent is currently offline" otherwise), inserts a
   `session_records` row with `status='active'`, and returns
   `{session_id, status, websocket_url}`.
3. Frontend routes to `/sessions/{id}`; `DesktopView` mounts and opens the
   browser WebSocket **immediately** → the broker registers the session in
   `broker_manager.active_browsers`.

### 2.4 Agent attaches
The agent polls `GET /api/v1/agent/sessions?agent_id=agt_1234` every **2 s**.
The endpoint returns only sessions that are (a) active, (b) on this agent's
host, and (c) **have a browser WebSocket currently connected** — the
browser-connected filter stops agents from burning capture threads on orphaned
sessions nobody is watching.

On a qualifying session the agent:
1. Opens `WS /api/v1/ws/agent/{agent_id}` and sends the **session_id as its
   first text message** — this binds the socket to the streams.
2. Spawns a supervised `DesktopWorker` task.
3. The worker sends `hello {mode:"desktop", width, height}` and starts the
   capture thread.

### 2.5 Streaming
**Output (screen → browser):** a dedicated capture thread grabs the monitor
with `mss`, compares raw pixels against the last frame (**identical screens are
skipped** — no encode, no send), encodes changed frames to JPEG with Pillow
(quality 30–90, default 60), and pushes into a **bounded drop-oldest queue
(size 2)**. The sender task awaits frames and writes
`[0x03][jpeg bytes]` to the WebSocket. A slow network drops frames (lower fps)
instead of growing memory or blocking capture.

**Input (browser → screen):** `DesktopView` translates DOM events to JSON
(`mmove`, `mdown/mup`, `mclick`, `mwheel`, `key {key, mod[], down}`), sends
them as `[0x02][json]` frames. The agent applies them through `pynput`
controllers in an executor thread: mouse position/buttons/wheel, keyboard with
modifier handling and a held-key tracker.

### 2.6 Termination
* **User ends it:** End Session → `POST /sessions/{id}/terminate` → row set
  `closed`. The next agent poll no longer returns the session; the reconcile
  loop stops the worker, releases keys, closes the capture backend.
* **Agent dies / disconnects:** broker detects the closed socket; the browser
  shows "— broker disconnected —". The session row stays `active` until
  terminated (see *Known limitations*).
* **Browser closes:** the browser-connected filter removes the session from
  the agent's list → the worker winds down within one poll. Redis streams
  self-expire after **1 h** (`STREAM_TTL_SECONDS`), so unconsumed frames never
  accumulate.

---

## 3. The Frame Protocol

First byte of every binary WebSocket frame (the broker relays bytes verbatim
and never looks at them):

| Tag  | Direction       | Payload                                       |
|------|-----------------|-----------------------------------------------|
| `0x01` | both          | terminal bytes (SSH sessions)                 |
| `0x02` | both          | JSON control message (UTF-8)                  |
| `0x03` | agent → browser | full-frame JPEG (desktop sessions)          |

Control messages on `0x02`:

| Message | Direction | Meaning |
|---|---|---|
| `{"t":"hello","mode":"desktop","width":W,"height":H}` | agent→browser | stream metadata; browser sizes its canvas |
| `{"t":"bye","reason":"..."}` | agent→browser | worker ending (shell exited, capture unavailable, …) |
| `{"t":"resize","cols":C,"rows":R}` | browser→agent | terminal window size (SSH only) |
| `{"t":"mmove","x":X,"y":Y}` | browser→agent | mouse move (agent screen coords) |
| `{"t":"mdown"/"mup","b":1..3,"x":X,"y":Y}` | browser→agent | button press/release |
| `{"t":"mclick","b":1..3,"clk":N,"x":X,"y":Y}` | browser→agent | click / double-click |
| `{"t":"mwheel","dy":±N}` | browser→agent | scroll (Δ100 ≈ 1 wheel click) |
| `{"t":"key","key":"c","mod":["ctrl"],"down":true}` | browser→agent | keypress with modifiers |
| `{"t":"quality","q":70}` | browser→agent | change JPEG quality (30–90) |

Coordinates: the browser maps canvas-relative positions to agent screen pixels
using the `hello` dimensions. Browser special keys map to `pynput` keys
(arrows, F1–F12, enter/backspace/tab/escape/…); F11/F12 stay reserved for the
browser itself.

Redis encoding detail: the broker hex-encodes bytes into stream entries
(`{"data": "<hex>"}`) and consumer groups ack after delivery. Hex doubles the
payload size — acceptable for MVP, switch to raw bytes if throughput matters.

---

## 4. Module Inventory

### 4.1 Agent — `agent/pam_agent.py` (single file, ~700 lines)

| Module | Responsibility |
|---|---|
| `Agent` (supervisor) | Heartbeat loop, session poll loop, worker registry, attach throttle (min 5 s per session id), max concurrent sessions (default 5), signal handling, clean shutdown (kills children, final offline heartbeat) |
| `ControlClient` | HTTP (stdlib `urllib`, run in executor) + WebSocket factory (`websockets` lib, keepalive ping 20 s / timeout 10 s, bounded receive buffers) |
| `DesktopWorker` | One supervised task per rdp session; owns the capture thread + sender/receiver pumps; failure sentinel stops broken captures after 30 failures |
| `DesktopBackend` | mss capture (instance created **in the capturing thread** — mss connections are thread-bound), Pillow JPEG encode, pynput mouse/keyboard injection, held-key tracking, frame-diff skip |
| `queue_DropOldest` | Thread-safe bounded queue (stdlib `queue.Queue`); when full the oldest frame is dropped — the core "never block capture" mechanism |
| `ShellProcess` | (SSH sessions) real PTY on POSIX (`pty.openpty`, `TIOCSWINSZ` resize, own process group for clean kills), pipes + `cmd.exe` on Windows with a manual echo shim |

### 4.2 Backend — FastAPI (`app/`)

| File | Responsibility |
|---|---|
| `api/v1/endpoints/broker_ws.py` | `/ws/browser/{id}` and `/ws/agent/{agent_id}` — each runs two pumps: socket→Redis publish, Redis consume→socket |
| `broker/streamer.py` | Stream names, `xadd` hex publish, TTL (1 h), `xreadgroup` consume with 20 ms poll (keeps round-trip latency ~40 ms) |
| `broker/manager.py` | In-memory registry of live browser/agent sockets; the browser set feeds the agent-session filter; disconnects are cleaned up |
| `api/v1/endpoints/agent.py` | `POST /agent/heartbeat`, `POST /agent/offline`, `GET /agent/sessions` (browser-connected filter) |
| `api/v1/endpoints/sessions.py` | Create / list / detail / terminate session; list joins users+hosts for display fields |
| `services/session_service.py` | Session lifecycle logic |

### 4.3 Frontend — Next.js 14 (`frontend/src/`)

| File | Responsibility |
|---|---|
| `components/terminal/DesktopView.tsx` | Canvas renderer (`createImageBitmap` per frame), pointer/keyboard capture → tagged JSON frames, status overlay (connecting / live / ended + reason) |
| `components/terminal/TerminalView.tsx` | xterm.js for SSH sessions; tags outbound bytes `0x01`, parses inbound tags, sends resize controls |
| `app/sessions/[id]/page.tsx` | Full-screen session chrome: top bar (host, type, LIVE/REC badges, End Session), collapsible sidebar, latency/bytes status bar; picks Desktop vs Terminal view by session type |
| `lib/api.ts` | Typed client, `X-User-Id` header, snake_case→camelCase mappers |
| `lib/app-store.tsx` | Live data (10 s poll), offline detection + retry, session create/terminate actions |

### 4.4 Third-party libraries

| Lib | Where | Why |
|---|---|---|
| `websockets` | agent | Asyncio WebSocket client with keepalive/backpressure knobs |
| `mss` | agent | Cross-platform screen capture (X11 / Win32 GDI / macOS CGDisplay) |
| `Pillow` | agent | JPEG encode with quality control |
| `pynput` | agent | Cross-platform mouse/keyboard **injection** (and monitoring, unused) |
| `xterm.js` | browser | Terminal emulator for SSH sessions |
| Redis streams | broker | Buffered relay + replay + future recording tap |

---

## 5. Resource-Safety Design (why it can't hang the machines)

* **Isolation** — every session is one supervised asyncio task; a crash is
  logged (`terminal/desktop pump error: …`) and contained. The supervisor
  outlives all workers.
* **Bounded queues** — capture → send is a drop-oldest queue of 2; receive
  sockets have `max_queue`/`max_size` caps. Memory is O(1) per session.
* **Rate caps** — capture at `--fps` (default 10), input applied in a single
  executor thread, attach attempts throttled to 1 per 5 s per session.
* **Clean kills** — shells run in their own process group (SIGTERM → 3 s →
  SIGKILL); no orphan shells. Desktop workers release held keys on exit.
* **Dead-peer detection** — WS ping 20 s / timeout 10 s kills half-open TCP.
* **Self-expiring streams** — Redis TTL 1 h prevents unbounded growth from
  orphaned sessions.
* **Global cap** — `--max-sessions` (default 5) per agent.

---

## 6. "Black Screen but Mouse Control Works" — Complete Diagnostic Guide

This symptom is **not one bug — it's a family of them**, and it always means
the same structural thing: the **input path works** (browser → broker → Redis
input stream → agent → pynput → OS) while the **output path is broken
somewhere** (mss → JPEG → queue → WS → Redis output stream → browser consume →
canvas). The paths are fully independent after the broker.

Work from the agent outward:

### Step 1 — read the agent console

| Agent log shows | Diagnosis | Fix |
|---|---|---|
| `first frame WxH, ~5–15 KB` | Capture returns a **black image** (real desktops at 1080p/q60 are ~100–400 KB; dark themes ~40 KB+) | Almost always **Wayland** — see Cause A |
| No `first frame` at all, browser shows a `bye` reason | Capture failing (`mss` exception, no permissions) | Read the reason string; grant permissions / Cause G |
| No `attached to rdp session …` line ever | **Agent never attached** — input can't work either, so if mouse moved this isn't your case; if it is, see Cause C/E | Check agent_id ↔ host pairing, browser tab open |
| `can't concat coroutine to bytes` | The v0.3.1 queue bug (async `get()` called via executor) | Deploy ≥ v0.3.2 |
| `first frame … 100+ KB` + healthy fps on movement | Agent is streaming fine — problem is **browser-side** | Cause F, or network |

### Step 2 — every known cause

**A. Wayland session on Linux (the most common).**
`echo $XDG_SESSION_TYPE` → if `wayland`: X11 screen grabs (mss) capture the
**XWayland root window, which is black** — Wayland doesn't render into it.
Meanwhile pynput's XTest injection **still moves the real cursor**, because
input injection goes through a different mechanism than screen reading.
Symptom match is exact: black screen + working mouse/keyboard.
*Fix:* log into an **"Ubuntu on Xorg"** session (gear icon at the login
screen). Proper Wayland support needs PipeWire/portal capture (roadmap).

**B. mss thread-affinity bug (agent ≤ v0.3.1).**
`mss` connections are bound to the thread that created them. The agent created
the capture instance in the **event-loop thread** and used it from the
**capture thread** → black or failed grabs. Fixed in **v0.3.2**: the instance
is now created lazily inside whichever thread calls `capture_jpeg()`
(`_grabber()` checks `threading.get_ident()`).
*Fix:* deploy ≥ v0.3.2 (check the startup banner says `pam_agent v0.3.2`).

**C. Session on a host no agent serves.**
If the host row's `agent_id` doesn't match any running agent (typical: leftover
test hosts, or the agent runs `--agent-id agt_XXXX` while the host was
registered with `agt_1234`), the browser connects, prints "Channel established
— streaming", and **silently waits forever**. No agent WS ever appears in the
server log.
*Diagnose:* server log has zero `WebSocket /ws/agent/... [accepted]` lines
while polls continue; `docker exec pam_postgres psql -U pam_admin -d pam_db -c
"SELECT hostname, agent_id FROM hosts;"` shows the mismatch.
*Fix:* run the agent with the **exact** agent_id from the host row, or delete
the dead host row. (The agent now also warns loudly when its agent_id is not
registered.)

**D. The v0.3.1 crash loop.**
The frame queue's `get()` was `async def` but invoked through
`run_in_executor`, so calling it in a plain thread produced a coroutine that
never ran — `jpeg` was never bytes, the first send threw
`TypeError: can't concat coroutine to bytes`, the worker died, and the poller
reattached every 2 s (visible as WS connect/disconnect churn in the server
log). Input worked because that path never touched the queue.
*Fix:* ≥ v0.3.2 (stdlib `queue.Queue` with blocking `get`).

**E. Browser tab not open / not connected.**
`GET /agent/sessions` only returns sessions with a **live browser WebSocket**
(added to stop agents burning CPU on orphans). If you create a session via
API/curl and never open `/sessions/{id}` in a browser, no agent will ever
attach. Also: the tab must **stay open** for the stream to keep running.
*Fix:* open the session page and keep it open.

**F. Stale cached frontend JS.**
Next.js dev serves updated bundles, but an already-open tab keeps the old code.
Tell-tale sign: UI elements that current code can't render (e.g. a `● REC`
badge when no recording URL exists).
*Fix:* hard refresh — `Ctrl+Shift+R` — and close old tabs.

**G. Capture genuinely unavailable.**
macOS without **Screen Recording** (+ **Accessibility** for input) permissions;
missing deps (`pip install mss Pillow pynput`); no active display on a headless
server. The worker now sends a tagged `bye` with the reason and the browser
prints it instead of hanging.
*Fix:* grant permissions / install deps / use a machine with a display.

**H. "Black" that is actually *frozen*.**
Frame-diff skip means an **unchanged remote screen sends zero frames** —
`stream: 0.0 fps` is *correct* on an idle desktop. If the picture is stale
rather than black, inject movement (move the mouse in the browser): fps should
spike and the frame update. If fps spikes but the canvas never repaints, the
problem is browser-side (canvas sizing, old JS) — check DevTools → Network →
WS → Messages to see frames arriving.

**I. Redis consumer-group residue (rare).**
The broker consumes the output stream with a fixed group (`browser-group`,
consumer `worker-1`). A browser that died mid-frame can leave messages
**pending** (delivered, unacked). New messages still flow via `>`, so this
rarely blocks a live session; if streams look wedged after heavy reconnect
testing:
`redis-cli XGROUP DESTROY session:{id}:output browser-group` (and `agent-group`
on the input stream), or simply `redis-cli FLUSHDB` in dev. Streams also
self-expire after 1 h.

### Step 3 — quick reference table

| Observation | Cause |
|---|---|
| Mouse works, black canvas, `first frame ~5–15 KB` | A (Wayland) |
| Mouse works, black canvas, `TypeError … coroutine` in agent log | D (≤0.3.1) |
| Nothing works, no agent WS in server log, host mismatch in DB | C |
| Browser shows bye-reason instead of desktop | G |
| `0.0 fps` but picture fine until you move the mouse | H (by design) |
| Agent streams fine, canvas never repaints | F (stale JS) / browser bug |

---

## 7. Platform Matrix

| | Linux | Windows | macOS |
|---|---|---|---|
| Terminal | real PTY (echo, resize, colors) | pipes + `cmd.exe` + manual echo shim (ConPTY = upgrade path) | real PTY |
| Screen capture | mss via **X11 only** (Wayland → black, see Cause A) | mss via GDI — works out of the box | mss via CGDisplay — needs **Screen Recording** permission |
| Input injection | pynput/XTest (X11) | pynput/Win32 | pynput — needs **Accessibility** permission |
| Run as | user or systemd unit in the X session | interactive login session (**not** a session-0 service — services can't capture the user desktop) | login agent with TCC grants |
| First-time setup | `pip install -r requirements.txt` | same (+ optional `pywinpty`) | same + grant the two permissions |

Tuning: `--fps` (default 10), `--quality` (default 60), `--monitor`
(1 = primary), `--max-sessions`, `--no-desktop`, `--no-terminal`,
`--verbose`.

---

## 8. Known Limitations & Roadmap

* **No agent authentication** — anyone knowing an agent_id can connect as that
  host. Add a per-agent token (WS query param + broker check) and TLS before
  any real deployment. This is the biggest gap.
* **Stale `active` sessions** — if both browser and agent vanish without a
  terminate call, the row stays `active` forever (harmless: no agent attaches
  without a browser, streams expire — but the list gets cluttered). A
  periodic sweeper closing sessions idle > N minutes is a 20-line addition.
* **Recording** — not built yet. The tap point is ready: a second consumer
  group on `session:{id}:output` records terminal bytes (asciinema cast) and
  desktop JPEGs (timestamped frames) without touching the live path.
* **Wayland** capture/injection (PipeWire RemoteDesktop portal), clipboard
  sharing, resolution negotiation, multi-monitor selection UI, cursor rendering
  (currently the remote cursor is invisible — you drive it blind, local canvas
  shows a crosshair).
* **RDP protocol features** (RDP clipboard/file redirection, GPU accel,
  bandwidth auto-negotiation beyond the drop-oldest queue) are out of scope;
  this is a lightweight frame-stream design by choice.

---

## 9. File Map (where everything lives)

```
pam-server/
├── agent/
│   ├── pam_agent.py          # the agent (single file)
│   ├── requirements.txt      # websockets (core) + mss/Pillow/pynput (desktop)
│   └── README.md             # agent quickstart
├── app/
│   ├── api/v1/endpoints/
│   │   ├── broker_ws.py      # browser/agent WebSockets
│   │   ├── agent.py          # heartbeat / offline / sessions-for-agent
│   │   ├── sessions.py       # create / list / detail / terminate
│   │   └── hosts.py          # register / list / delete
│   ├── broker/
│   │   ├── manager.py        # live socket registry
│   │   └── streamer.py       # Redis stream publish/consume + TTL
│   └── services/…            # session/host/auth services
├── frontend/src/
│   ├── components/terminal/DesktopView.tsx    # canvas viewer + input events
│   ├── components/terminal/TerminalView.tsx   # xterm.js SSH view
│   └── app/sessions/[id]/page.tsx             # session chrome
└── docs/rdp-session-architecture.md           # this file
```
