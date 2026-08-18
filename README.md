# PAM Server — Privileged Access Management Control Plane

A self-hosted remote access platform that lets you manage, monitor, and connect to any machine through a browser — terminal sessions and full desktop streaming, with no VPN required.

---

## What It Does

| Feature | Details |
|---|---|
| 🖥️ **Remote Terminal** | Real PTY on Linux/macOS, pipe-based shell on Windows |
| 🖱️ **Desktop Streaming** | Live JPEG screen stream + full mouse & keyboard injection |
| 🔌 **WebSocket Broker** | Real-time binary protocol between the browser and agent |
| 🤖 **Lightweight Agent** | Single Python file deployed on the target machine |
| 🔐 **Auth** | JWT-based API authentication |
| 📦 **PostgreSQL + Redis** | Persistent host/session storage + real-time message brokering |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Browser (Next.js)                  │
│           Terminal UI  │  Desktop Viewer                │
└──────────────┬─────────┴──────────┬────────────────────┘
               │  REST / WebSocket  │
               ▼                    ▼
┌─────────────────────────────────────────────────────────┐
│               PAM Server  (FastAPI / Python)            │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │  /auth   │  │  /hosts  │  │/sessions │  │/agents │ │
│  └──────────┘  └──────────┘  └──────────┘  └────────┘ │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │            WebSocket Broker  (/ws/*)              │  │
│  │   browser ◄──── binary frames ────► agent        │  │
│  └──────────────────────────────────────────────────┘  │
│                                                         │
│  ┌──────────────────┐     ┌──────────────────────────┐ │
│  │   PostgreSQL     │     │          Redis            │ │
│  │  hosts/sessions  │     │  stream brokering / pub   │ │
│  └──────────────────┘     └──────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
               ▲
               │  WebSocket (auto-reconnect)
               ▼
┌─────────────────────────────────────────────────────────┐
│                  PAM Agent  (pam_agent.py)              │
│                                                         │
│   ShellProcess (PTY / pipes)   DesktopBackend           │
│   TerminalWorker               DesktopWorker            │
│                                                         │
│   Screen capture backends (auto-selected):              │
│     mss  →  X11 / XWayland / Windows / macOS           │
│     grim →  Wayland wlr-screencopy  (sway / Hyprland)  │
│     portal → xdg-desktop-portal + PipeWire (GNOME)     │
└─────────────────────────────────────────────────────────┘
```

### Frame Protocol (Binary WebSocket)

Each WebSocket message starts with a 1-byte tag:

| Tag | Meaning | Direction |
|-----|---------|-----------|
| `0x01` | Raw terminal bytes | Both ways |
| `0x02` | JSON control message | Both ways |
| `0x03` | Full-frame JPEG | Agent → Browser |

---

## Project Structure

```
pam-server/
├── main.py                  # FastAPI app entry point
├── requirements.txt         # Server Python dependencies
├── docker-compose.yml       # PostgreSQL + Redis
├── alembic/                 # DB migrations
│
├── app/
│   ├── api/v1/endpoints/    # REST + WebSocket endpoints
│   │   ├── auth.py          #   JWT login
│   │   ├── hosts.py         #   Host registration & listing
│   │   ├── sessions.py      #   Session management
│   │   ├── agent.py         #   Agent registration
│   │   └── broker_ws.py     #   WebSocket broker
│   ├── broker/
│   │   ├── manager.py       # Active connection registry
│   │   └── streamer.py      # Redis stream relay
│   ├── core/
│   │   ├── config.py        # Settings (loaded from .env)
│   │   ├── exceptions.py    # Custom HTTP exceptions
│   │   └── monitor.py       # Request monitoring middleware
│   ├── infrastructure/
│   │   ├── database.py      # Async SQLAlchemy setup
│   │   └── redis_client.py  # Redis connection
│   ├── models/              # SQLAlchemy ORM models
│   ├── schemas/             # Pydantic request/response schemas
│   └── services/            # Business logic layer
│
├── agent/
│   ├── pam_agent.py         # Standalone agent (deploy on target)
│   ├── wayland_capture.py   # Wayland portal/PipeWire capture
│   └── requirements.txt     # Agent Python dependencies
│
└── frontend/                # Next.js web UI
    └── src/
```

---

## How to Use

### Prerequisites

- Python 3.11+
- Node.js 18+ (for the frontend)
- Docker & Docker Compose (for PostgreSQL + Redis)

---

### 1. Clone the repo

```bash
git clone https://github.com/your-username/pam-server.git
cd pam-server
```

### 2. Start the database and Redis

```bash
docker compose up -d
```

### 3. Set up the server

```bash
# Create and activate a virtual environment
python -m venv env
source env/bin/activate        # Linux/macOS
# env\Scripts\activate         # Windows

# Install dependencies
pip install -r requirements.txt

# Copy and edit the environment file
cp .env.example .env           # edit values if needed
```

**`.env` variables:**

```env
APP_NAME="PAM-Control-Plane"
DEBUG=True
API_V1_PREFIX="/api/v1"

POSTGRES_USER=pam_admin
POSTGRES_PASSWORD=super_secret_password
POSTGRES_SERVER=localhost
POSTGRES_PORT=5432
POSTGRES_DB=pam_db

REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DB=0
```

### 4. Run database migrations

```bash
alembic upgrade head
```

### 5. Start the server

```bash
python main.py
# Server runs at http://localhost:8000
# API docs at  http://localhost:8000/docs
```

### 6. Start the frontend

```bash
cd frontend
npm install
npm run dev
# UI runs at http://localhost:3000
```

---

### 7. Deploy the agent on a target machine

Copy `agent/pam_agent.py` (and `wayland_capture.py` on Linux) to the target machine.

```bash
# Install agent dependencies on the target machine
pip install websockets mss Pillow pynput

# Run the agent (terminal-only)
python pam_agent.py --server http://<your-server-ip>:8000 --agent-id agt_XXXX

# Run the agent with desktop streaming enabled
python pam_agent.py --server http://<your-server-ip>:8000 --agent-id agt_XXXX

# Disable desktop streaming (terminal only)
python pam_agent.py --server http://<your-server-ip>:8000 --agent-id agt_XXXX --no-desktop
```

#### Desktop capture backends (Linux)

The agent picks the best available backend automatically:

| Environment | Backend used |
|---|---|
| X11 / XWayland | `mss` — instant, no setup |
| Wayland + sway/Hyprland | `grim` — `sudo apt install grim` |
| Wayland + GNOME | xdg-desktop-portal — one-time consent dialog |
| Windows / macOS | `mss` — instant, no setup |

---

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/auth/login` | Get a JWT token |
| `GET` | `/api/v1/hosts` | List registered hosts |
| `POST` | `/api/v1/hosts` | Register a new host |
| `DELETE` | `/api/v1/hosts/{id}` | Remove a host |
| `GET` | `/api/v1/sessions` | List sessions |
| `POST` | `/api/v1/sessions` | Create a session |
| `WS` | `/api/v1/ws/browser/{session_id}` | Browser WebSocket |
| `WS` | `/api/v1/ws/agent/{agent_id}` | Agent WebSocket |

Full interactive docs available at **`http://localhost:8000/docs`** when the server is running.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Server | FastAPI, Python 3.11, Uvicorn |
| Database | PostgreSQL 16, SQLAlchemy (async) |
| Cache / Broker | Redis 7 |
| Agent | Pure Python, `websockets`, `mss`, `pynput` |
| Frontend | Next.js, TypeScript, Tailwind CSS |
| Containerization | Docker Compose |
