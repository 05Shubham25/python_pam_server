# PAM Server — Privileged Access Management Control Plane

A self-hosted remote access platform that lets you manage, monitor, and connect to any machine through a browser — real terminal sessions and live remote desktop streaming, with no VPN required.

---

## Features

| Feature | Details |
|---|---|
| 🖥️ **Remote Terminal** | Real PTY on Linux/macOS, pipe-based interactive shell on Windows |
| 🖱️ **Desktop Streaming** | High-performance JPEG screen streaming + real-time mouse & keyboard control |
| 🔌 **WebSocket Broker** | Low-latency binary protocol connecting the web UI and target agents |
| ⚡ **Go Client (`go_agent`)** | High-performance, zero-dependency Go agent for Windows, Linux, and macOS |
| 🔐 **Authentication** | JWT-based secure API authentication |
| 📦 **PostgreSQL + Redis** | Persistent storage for hosts/sessions + Redis Stream real-time brokering |

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
│                  Go Agent  (go_agent)                   │
│                                                         │
│   ShellProcess (PTY / Pipes)   DesktopBackend           │
│   TerminalWorker               DesktopWorker            │
│                                                         │
│   Supported OS & Screen Capture Backends:               │
│     Windows  → Win32 GDI API + SendInput API           │
│     Linux    → gnome-screenshot / grim / scrot / import   │
│     macOS    → screencapture + cliclick CLI             │
└─────────────────────────────────────────────────────────┘
```

### WebSocket Binary Protocol

All communication between browser and agent uses binary WebSocket frames prefixed with a 1-byte header tag:

| Tag | Meaning | Direction |
|-----|---------|-----------|
| `0x01` | Raw terminal PTY bytes | Bidirectional |
| `0x02` | JSON control messages (input events, resize, keepalive) | Bidirectional |
| `0x03` | Full-frame JPEG screen capture | Agent → Browser |

---

## Project Structure

```
python_pam_server/
├── main.py                  # FastAPI server entry point
├── init_db.py               # Database initialization script
├── requirements.txt         # Server Python dependencies
├── docker-compose.yml       # PostgreSQL 16 + Redis 7 services
│
├── app/                     # FastAPI backend application
│   ├── api/v1/endpoints/    # REST API & WebSocket endpoints
│   ├── broker/              # Redis stream broker & connection manager
│   ├── core/                # Application configuration & security
│   ├── infrastructure/      # Async database & Redis clients
│   ├── models/              # SQLAlchemy database ORM models
│   └── services/            # Business logic layer
│
├── go_agent/                # High-performance Go agent (deploy on target)
│   ├── main.go              # Agent CLI entrypoint & session supervisor
│   ├── client.go            # REST & WebSocket client
│   ├── terminal.go          # Interactive terminal session worker
│   ├── desktop.go           # Remote desktop session worker
│   ├── desktop_windows.go   # Win32 GDI screen capture
│   ├── input_windows.go     # Win32 SendInput input injection
│   ├── desktop_linux.go     # Linux Wayland / X11 screen capture
│   ├── shell_unix.go        # POSIX PTY allocation
│   └── shell_windows.go     # Windows Command Prompt pipe process
│
└── frontend/                # Next.js 14 web interface
```

---

## Getting Started & Installation

### Prerequisites

- **Python 3.11+**
- **Node.js 18+** (for frontend)
- **Docker & Docker Compose** (for PostgreSQL & Redis)
- **Go 1.21+** (optional, only if compiling `go_agent` from source)

---

### 1. Start Database & Cache (Docker)

Start PostgreSQL and Redis container services:

```bash
docker compose up -d
```

---

### 2. Set Up & Start Server (FastAPI)

```bash
# 1. Create and activate a virtual environment
python -m venv env

# On Linux/macOS:
source env/bin/activate

# On Windows (PowerShell):
.\env\Scripts\Activate.ps1

# 2. Install dependencies
pip install -r requirements.txt

# 3. Create .env configuration
cp .env.example .env

# 4. Initialize database tables
python init_db.py

# 5. Start the FastAPI server
python main.py
```

The server runs at **`http://localhost:8000`**.  
Interactive API docs are available at **`http://localhost:8000/docs`**.

---

### 3. Start Frontend (Next.js)

In a new terminal window:

```bash
cd frontend
npm install
npm run dev
```

The Web UI runs at **`http://localhost:3000`**.

---

### 4. Deploy & Run the Go Agent (`go_agent`)

The agent runs on the target machine you want to access remotely.

#### **A. Running on Windows Target Machine**

Download or build `pam-agent.exe` from `go_agent/` and run it from Command Prompt or PowerShell:

```cmd
pam-agent.exe --server http://<server-ip>:8000 --agent-id agt_XXXX
```

> **Tip:** Run Command Prompt **as Administrator** to enable elevated desktop control (Taskbar, Start Menu, System Tray).

#### **B. Running on Linux Target Machine**

1. Install required desktop dependencies on the Linux machine:

```bash
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y gnome-screenshot xdotool

# Fedora / RHEL
sudo dnf install -y gnome-screenshot xdotool

# Arch Linux
sudo pacman -S gnome-screenshot xdotool
```

2. Transfer and run `pam-agent-linux-amd64`:

```bash
chmod +x pam-agent-linux-amd64

./pam-agent-linux-amd64 --server http://<server-ip>:8000 --agent-id agt_XXXX
```

#### **C. Compiling Go Agent Binaries from Source**

You can cross-compile Go agent binaries for any platform directly from `go_agent/`:

```powershell
cd go_agent

# Build Windows 64-bit binary (.exe)
go build -o pam-agent.exe .

# Cross-compile for Linux 64-bit (x86_64)
$env:GOOS="linux"; $env:GOARCH="amd64"; go build -o pam-agent-linux-amd64 .

# Cross-compile for Linux ARM64 (Raspberry Pi / ARM servers)
$env:GOOS="linux"; $env:GOARCH="arm64"; go build -o pam-agent-linux-arm64 .
```

#### **Agent CLI Options**

| Flag | Default | Description |
|---|---|---|
| `--server` | *(Required)* | Server base URL (e.g., `http://192.168.1.35:8000`) |
| `--agent-id` | *(Required)* | Registered agent ID matching a host entry |
| `--max-sessions` | `5` | Maximum concurrent terminal/RDP sessions |
| `--fps` | `10` | Frame rate cap for desktop capture (1-30) |
| `--quality` | `60` | JPEG compression quality (30-90) |
| `--no-desktop` | `false` | Disable remote desktop streaming (terminal only) |
| `--no-terminal` | `false` | Disable interactive shell sessions |

---

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/auth/login` | Authenticate user and get JWT |
| `GET` | `/api/v1/hosts` | List all registered target hosts |
| `POST` | `/api/v1/hosts` | Register a new target host |
| `DELETE` | `/api/v1/hosts/{id}` | Delete a registered host |
| `GET` | `/api/v1/sessions` | List active user sessions |
| `POST` | `/api/v1/sessions` | Create a new terminal or RDP session |
| `WS` | `/api/v1/ws/browser/{session_id}` | Browser UI WebSocket connection |
| `WS` | `/api/v1/ws/agent/{agent_id}` | Go Agent WebSocket connection |

Full interactive API documentation is available at **`http://localhost:8000/docs`**.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Server** | FastAPI, Python 3.11, Uvicorn, Pydantic v2 |
| **Database** | PostgreSQL 16, Async SQLAlchemy |
| **Cache & Broker** | Redis 7 Streams |
| **Agent** | Go 1.21+, Win32 GDI / SendInput, `gnome-screenshot` / `xdotool` |
| **Frontend** | Next.js 14, TypeScript, Tailwind CSS, Lucide Icons |
| **Containers** | Docker Compose |
