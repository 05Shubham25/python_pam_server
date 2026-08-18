#!/usr/bin/env python3
"""
PAM Agent — connects a machine to the PAM control plane.

Terminal sessions: real PTY on POSIX, pipes on Windows.
Desktop sessions:  mss screen capture -> tagged JPEG frames over the broker,
                   browser input events -> pynput injection.

Frame protocol over the broker's binary WebSocket (first byte):
  0x01  terminal bytes            (both directions)
  0x02  JSON control message      (both directions)
  0x03  full-frame JPEG           (agent -> browser)

Resource safety: every session is an isolated supervised task; capture uses a
bounded drop-oldest queue; children are killed by process group on exit;
websockets have keepalive timeouts so dead peers cannot leak tasks.

Usage:
  python pam_agent.py --server http://localhost:8000 --agent-id agt_XXXX
  python pam_agent.py --server http://localhost:8000 --agent-id agt_XXXX --no-desktop
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional

import websockets

log = logging.getLogger("pam-agent")

AGENT_VERSION = "0.5.0"

TAG_TTY = 0x01
TAG_CTRL = 0x02
TAG_JPEG = 0x03


def ctrl(msg: dict) -> bytes:
    """Encode a control message as a tagged frame."""
    return bytes([TAG_CTRL]) + json.dumps(msg).encode()

HEARTBEAT_INTERVAL = 10.0
HEARTBEAT_STALE_AFTER = 45.0  # server-side: host considered offline after this
POLL_INTERVAL = 2.0
WS_KWARGS = dict(
    ping_interval=20,
    ping_timeout=10,
    close_timeout=5,
    max_queue=64,      # bound receive buffers — never grow unbounded
    max_size=8 * 1024 * 1024,
)

IS_POSIX = os.name == "posix"


# --------------------------------------------------------------------------
# platform: terminal process
# --------------------------------------------------------------------------

class ShellProcess:
    """Cross-platform child shell. POSIX gets a real PTY, Windows uses pipes."""

    def __init__(self, cols: int = 120, rows: int = 30):
        self.cols, self.rows = cols, rows
        self.proc: Optional[subprocess.Popen] = None
        self.master_fd: Optional[int] = None  # POSIX PTY master
        self._pgid: Optional[int] = None

    def start(self) -> None:
        if IS_POSIX:
            self._start_pty()
        else:
            self._start_pipes()

    def _start_pty(self) -> None:
        import pty
        import termios
        import fcntl
        import struct

        master, slave = pty.openpty()
        # sane initial terminal size; the shell/apps set their own modes —
        # the agent must NOT setraw here (that would kill kernel ECHO and
        # typed characters would never appear on screen)
        fcntl.ioctl(slave, termios.TIOCSWINSZ,
                    struct.pack("HHHH", self.rows, self.cols, 0, 0))
        shell = os.environ.get("SHELL") or "/bin/sh"
        self.proc = subprocess.Popen(
            [shell, "-i"],
            stdin=slave, stdout=slave, stderr=slave,
            close_fds=True,
            preexec_fn=os.setsid,  # own process group -> clean kill
        )
        os.close(slave)
        self.master_fd = master
        self._pgid = self.proc.pid

    def _start_pipes(self) -> None:
        cmd = os.environ.get("COMSPEC", "cmd.exe")
        creationflags = 0
        if sys.platform == "win32":
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
        self.proc = subprocess.Popen(
            [cmd],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=creationflags,
            bufsize=0,
        )
        self._pgid = None

    def resize(self, cols: int, rows: int) -> None:
        self.cols, self.rows = cols, rows
        if self.master_fd is not None:
            import termios
            import fcntl
            import struct
            try:
                fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ,
                            struct.pack("HHHH", rows, cols, 0, 0))
            except OSError:
                pass

    def read(self, size: int = 65536):
        """Blocking read of shell output; b'' means EOF."""
        if self.master_fd is not None:
            try:
                return os.read(self.master_fd, size)  # returns as data arrives
            except OSError:
                return b""  # all slave ends closed -> EOF
        stream = self.proc.stdout
        if stream is None:
            return b""
        data = stream.read1(size) if hasattr(stream, "read1") else stream.read(size)
        return data or b""

    def write(self, data: bytes) -> None:
        if self.master_fd is not None:
            try:
                os.write(self.master_fd, data)
            except OSError:
                pass
        elif self.proc.stdin is not None:
            try:
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
            except (OSError, ValueError):
                pass

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self) -> None:
        if self.proc is None:
            return
        try:
            if self._pgid is not None and IS_POSIX:
                import signal as _sig
                try:
                    os.killpg(self._pgid, _sig.SIGTERM)
                except ProcessLookupError:
                    pass
            else:
                self.proc.terminate()
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                if self._pgid is not None and IS_POSIX:
                    os.killpg(self._pgid, signal.SIGKILL)
                else:
                    self.proc.kill()
            except (ProcessLookupError, OSError):
                pass
        finally:
            if self.master_fd is not None:
                try:
                    os.close(self.master_fd)
                except OSError:
                    pass
                self.master_fd = None


# --------------------------------------------------------------------------
# platform: desktop capture + input (optional deps)
# --------------------------------------------------------------------------

# Wayland portal capture lives in a sibling file; the agent still runs
# without it anywhere else (Windows/macOS/X11 use mss below).
try:
    from wayland_capture import (
        WaylandPortalCapture,
        is_wayland,
        portal_available,
    )
except ImportError:  # wayland_capture.py not shipped to this machine
    WaylandPortalCapture = None  # type: ignore[assignment,misc]

    def is_wayland() -> bool:  # type: ignore[misc]
        return False

    def portal_available() -> tuple:  # type: ignore[misc]
        return False, "wayland_capture.py missing next to pam_agent.py"


class DesktopBackend:
    """Screen capture + input injection. Degrades gracefully.

    Capture backend chosen at probe() time:
      * Wayland + portal  → xdg-desktop-portal + PipeWire (full-screen, first
                            run needs one consent click, then unattended)
      * Wayland + grim    → grim subprocess (wlr-screencopy, no dialog, works
                            on wlroots compositors: sway / Hyprland / river)
      * everything else   → mss (X11 / XWayland / Windows / macOS)
    """

    def __init__(self, monitor_index: int = 1, quality: int = 60):
        self.monitor_index = monitor_index
        self.quality = quality
        self._mode = "x11"  # "portal" | "grim" | "x11"
        self._portal = None
        self._mss = None
        self._mon = None
        self._ctrl = None
        self._kb = None
        self.error: Optional[str] = None
        self._input_lock = threading.Lock()
        self._held_keys: dict = {}
        self._last_frame: Optional[bytes] = None
        self.capture_broken = False
        self._grim_size: tuple = (0, 0)
        # optional TurboJPEG encoder (2-4x Pillow) for the mss/grim paths
        try:
            from turbojpeg import TurboJPEG
            self._tj = TurboJPEG()
        except Exception:
            self._tj = None

    # -- availability -----------------------------------------------------------
    def _try_grim(self) -> bool:
        """Return True if grim is installed and can capture one frame."""
        import subprocess, shutil
        if not shutil.which("grim"):
            return False
        try:
            r = subprocess.run(
                ["grim", "-t", "jpeg", "-q", "50", "-"],
                capture_output=True, timeout=5,
            )
            return r.returncode == 0 and len(r.stdout) > 0
        except Exception:
            return False

    def _try_mss_display(self) -> bool:
        """Return True if mss can capture using $DISPLAY (possibly XWayland)."""
        try:
            import mss  # noqa: F401
            # Probe: actually open a grab to make sure the display is live
            with mss.MSS() as probe:
                _ = probe.monitors
            return True
        except Exception:
            return False

    def probe(self) -> bool:
        try:
            import PIL  # noqa: F401
            import pynput  # noqa: F401
        except ImportError as e:
            self.error = f"desktop deps missing ({e}); run: pip install mss Pillow pynput"
            return False

        if is_wayland():
            # Priority 1: XWayland mss — instant, no dialog, works on any
            # compositor that has XWayland running (DISPLAY=:0).
            if os.environ.get("DISPLAY") and self._try_mss_display():
                self._mode = "x11"
                log.info("capture backend: mss/XWayland (DISPLAY=%s)",
                         os.environ["DISPLAY"])
                return True

            # Priority 2: grim — wlr-screencopy, no dialog (sway/Hyprland/river)
            if self._try_grim():
                self._mode = "grim"
                log.info("capture backend: grim (wlr-screencopy)")
                return True

            # Priority 3: portal — full Wayland capture, one-time consent dialog.
            # Requires xdg-desktop-portal-gnome / -gtk / -wlr backend.
            ok, err = portal_available()
            if ok:
                self._mode = "portal"
                log.info("capture backend: Wayland portal (PipeWire)")
                return True
            log.warning("portal not available: %s", err)

            self.error = (
                "Wayland detected but no capture backend available.\n"
                "Quickest fix (no dialog needed):\n"
                "  sudo apt install grim   # wlr-screencopy compositor\n"
                "Or ensure XWayland is running: DISPLAY=:0 should be set.\n"
                "Portal (one-time dialog): pip install dbus-next + GStreamer"
            )
            return False

        else:
            try:
                import mss  # noqa: F401
            except ImportError:
                self.error = "mss missing — pip install mss"
                return False
            self._mode = "x11"
            log.info("capture backend: mss (X11/Windows/macOS)")
            return True

    # -- capture ------------------------------------------------------------
    def open(self) -> None:
        import pynput.mouse
        import pynput.keyboard
        self._ctrl = pynput.mouse.Controller()
        self._kb = pynput.keyboard.Controller()

        if self._mode == "portal":
            # Negotiation can block on the first-run consent dialog — the
            # caller runs this whole method in an executor thread.
            # Timeout reduced to 15s; if dialog never appears we fail fast.
            self._portal = WaylandPortalCapture(quality=self.quality)
            self._portal.negotiate_blocking(timeout=15.0)
            self._portal.start()
            if not self._portal.wait_first_frame(timeout=5.0):
                raise RuntimeError("portal stream produced no frames")
            return

        if self._mode == "grim":
            # Verify grim still works; actual capture is done per-frame in
            # capture_jpeg() so nothing to initialise here.
            import subprocess
            r = subprocess.run(["grim", "-t", "jpeg", "-q", "50", "-"],
                               capture_output=True, timeout=5)
            if r.returncode != 0:
                raise RuntimeError(f"grim open test failed: {r.stderr.decode()[:200]}")
            # Determine screen size from one test frame
            from PIL import Image
            import io
            img = Image.open(io.BytesIO(r.stdout))
            self._grim_size = img.size
            log.info("grim screen size: %dx%d", *self._grim_size)
            return

        import mss
        # Only probe geometry here; the capture instance itself is created
        # lazily in whichever thread calls capture_jpeg() — mss connections
        # are thread-bound and cross-thread use yields black/failed grabs.
        with mss.MSS() as probe:
            monitors = probe.monitors
            idx = min(self.monitor_index, len(monitors) - 1)
            self._mon = monitors[max(idx, 0)]
        self._mss = None
        self._mss_thread: Optional[int] = None

    @property
    def size(self) -> tuple[int, int]:
        if self._mode == "portal" and self._portal is not None:
            return self._portal.size
        if self._mode == "grim":
            return self._grim_size
        return (self._mon["width"], self._mon["height"]) if self._mon else (0, 0)

    def _grabber(self):
        """mss instance bound to the calling thread."""
        import mss
        if self._mss is None or self._mss_thread != threading.get_ident():
            self._mss = mss.MSS()
            self._mss_thread = threading.get_ident()
        return self._mss

    def _encode_jpeg(self, raw: bytes, w: int, h: int, has_alpha: bool) -> bytes:
        # TurboJPEG (libjpeg-turbo) is 2-4x faster than Pillow — optional,
        # pip install PyTurboJPEG (+ system libturbojpeg0)
        if self._tj is not None:
            from turbojpeg import TJPF, TJSAMP
            return self._tj.encode(
                raw, w, h,
                pixel_format=TJPF.RGBA if has_alpha else TJPF.RGB,
                quality=self.quality, jpeg_subsample=TJSAMP.CHROMA_422,
            )
        from PIL import Image
        img = Image.frombytes("RGBA" if has_alpha else "RGB", (w, h), raw)
        if has_alpha:
            img = img.convert("RGB")
        import io
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=self.quality)
        return buf.getvalue()

    def set_quality(self, quality: int) -> None:
        self.quality = max(30, min(90, quality))
        if self._portal is not None:
            self._portal.set_quality(self.quality)

    def capture_jpeg(self) -> Optional[bytes]:
        """One frame as JPEG, or None (unchanged frame / transient failure)."""
        if self._mode == "portal":
            # frames arrive pre-encoded from the GStreamer pipeline —
            # Python never encodes, which is what makes 30+ fps possible
            frame = self._portal.get_latest_jpeg()
            if frame is None:
                return None
            jpeg, w, h = frame
            if jpeg == self._last_frame:
                return None
            self._last_frame = jpeg
            self.capture_broken = False
            return jpeg

        if self._mode == "grim":
            import subprocess, io
            try:
                r = subprocess.run(
                    ["grim", "-t", "jpeg", f"-q", str(self.quality), "-"],
                    capture_output=True, timeout=3,
                )
                if r.returncode != 0 or not r.stdout:
                    self.capture_broken = True
                    return None
                # grim already produces JPEG — pass through directly
                if r.stdout == self._last_frame:
                    return None
                self._last_frame = r.stdout
                self.capture_broken = False
                return r.stdout
            except Exception:
                self.capture_broken = True
                return None

        if self._mon is None:
            return None
        try:
            shot = self._grabber().grab(self._mon)
        except Exception:
            self.capture_broken = True
            return None
        self.capture_broken = False
        raw = shot.rgb  # bytes, RGB order
        if raw == self._last_frame:
            return None  # identical screen — skip encode & send
        self._last_frame = raw

        return self._encode_jpeg(raw, shot.size[0], shot.size[1], has_alpha=False)

    # -- input --------------------------------------------------------------
    _BUTTONS = {1: "left", 2: "middle", 3: "right"}

    def apply_event(self, msg: dict) -> None:
        import pynput.mouse
        import pynput.keyboard

        t = msg.get("t")
        with self._input_lock:
            try:
                if t == "mmove":
                    self._ctrl.position = (int(msg.get("x", 0)), int(msg.get("y", 0)))
                elif t == "mdown":
                    b = pynput.mouse.Button[self._BUTTONS.get(msg.get("b", 1), "left")]
                    self._ctrl.press(b)
                elif t == "mup":
                    b = pynput.mouse.Button[self._BUTTONS.get(msg.get("b", 1), "left")]
                    self._ctrl.release(b)
                elif t == "mclick":
                    b = pynput.mouse.Button[self._BUTTONS.get(msg.get("b", 1), "left")]
                    self._ctrl.position = (int(msg.get("x", 0)), int(msg.get("y", 0)))
                    self._ctrl.click(b, int(msg.get("clk", 1)))
                elif t == "mwheel":
                    dy = int(msg.get("dy", 0))
                    clicks = max(-5, min(5, round(dy / 100)))
                    if clicks:
                        self._ctrl.scroll(0, clicks)
                elif t == "key":
                    self._key_event(
                        msg.get("key", ""), tuple(msg.get("mod", [])),
                        bool(msg.get("down", True)),
                        pynput.keyboard,
                    )
            except Exception:
                log.debug("input event failed: %r", msg, exc_info=True)

    _SPECIAL = {
        "enter": "enter", "backspace": "backspace", "tab": "tab",
        "escape": "esc", "delete": "delete", "insert": "insert",
        "home": "home", "end": "end", "pageup": "page_up",
        "pagedown": "page_down", "capslock": "caps_lock", "space": "space",
        "arrowup": "up", "arrowdown": "down", "arrowleft": "left",
        "arrowright": "right", "printscreen": "print_screen",
    }

    def _key_event(self, key: str, mods: tuple, down: bool, kb) -> None:
        mod_keys = []
        for m in mods:
            name = {"ctrl": "ctrl", "control": "ctrl", "alt": "alt",
                    "shift": "shift", "meta": "cmd", "os": "cmd"}.get(m)
            if not name:
                continue
            try:
                mod_keys.append(kb.Key[name])
            except KeyError:
                pass

        k = key.lower()
        if k.startswith("f") and k[1:].isdigit() and 1 <= int(k[1:]) <= 12:
            pkey = kb.Key[f"f{k[1:]}"]
        elif k in self._SPECIAL:
            pkey = kb.Key[self._SPECIAL[k]]
        elif len(key) == 1:
            pkey = key
        else:
            return  # unmapped

        if down:
            for mk in mod_keys:
                if mk not in self._held_keys.values():
                    try:
                        kb.Controller.press(self._kb, mk)
                    except Exception:
                        pass
                    self._held_keys[id(mk)] = mk
            try:
                kb.Controller.press(self._kb, pkey)
                self._held_keys[id(pkey)] = pkey
            except Exception:
                pass
        else:
            try:
                kb.Controller.release(self._kb, pkey)
                self._held_keys.pop(id(pkey), None)
            except Exception:
                pass

    def release_all(self) -> None:
        import pynput.keyboard
        with self._input_lock:
            for kid, mk in list(self._held_keys.items()):
                try:
                    pynput.keyboard.Controller.release(self._kb, mk)
                except Exception:
                    pass
            self._held_keys.clear()

    def close(self) -> None:
        self.release_all()
        if self._portal is not None:
            try:
                self._portal.stop()
            except Exception:
                pass
            self._portal = None
        if self._mss is not None:
            try:
                self._mss.close()
            except Exception:
                pass
            self._mss = None


# --------------------------------------------------------------------------
# session workers
# --------------------------------------------------------------------------

@dataclass
class SessionInfo:
    id: str
    host_id: str
    session_type: str  # 'ssh' | 'rdp'
    status: str


class TerminalWorker:
    """PTY/pipe ⇄ tagged WebSocket."""

    def __init__(self, ws, session: SessionInfo, on_done):
        self.ws = ws
        self.session = session
        self.on_done = on_done
        self.shell = ShellProcess()

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        stop = asyncio.Event()
        out_q: asyncio.Queue = asyncio.Queue(maxsize=128)

        self.shell.start()
        # Pipes (Windows fallback) get no kernel echo — shim it so typed
        # characters stay visible. Real PTYs echo via the line discipline.
        self.manual_echo = self.shell.master_fd is None
        await self.ws.send(ctrl({"t": "hello", "mode": "terminal"}))

        def reader():
            """Dedicated OS thread: shell output -> queue (bounded)."""
            try:
                while not stop.is_set():
                    data = self.shell.read(65536)
                    if data == b"":
                        out_q.put_nowait(None)  # EOF
                        return
                    out_q.put_nowait(data)
            except Exception:
                out_q.put_nowait(None)

        thread = threading.Thread(target=reader, daemon=True, name=f"pty-{self.session.id[:8]}")
        thread.start()

        async def pump_out():
            """Queue -> websocket (backpressure-aware, chunk-capped)."""
            try:
                while True:
                    data = await out_q.get()
                    if data is None:
                        await self.ws.send(ctrl({"t": "bye", "reason": "shell exited"}))
                        await self.ws.close()
                        return
                    frame = bytes([TAG_TTY]) + data
                    await self.ws.send(frame)
            except (websockets.ConnectionClosed, asyncio.QueueEmpty):
                pass

        async def pump_in():
            """Websocket -> shell stdin."""
            try:
                async for msg in self.ws:
                    if isinstance(msg, bytes) and msg:
                        tag, payload = msg[0], msg[1:]
                        if tag == TAG_TTY:
                            if self.manual_echo:
                                stdin = self._translate(payload, echo=False)
                                await loop.run_in_executor(None, self.shell.write, stdin)
                                await self.ws.send(
                                    bytes([TAG_TTY]) + self._translate(payload, echo=True))
                            else:
                                await loop.run_in_executor(None, self.shell.write, payload)
                        elif tag == TAG_CTRL:
                            self._control(payload)
            except websockets.ConnectionClosed:
                pass

        try:
            done, pending = await asyncio.wait(
                [asyncio.create_task(pump_out()), asyncio.create_task(pump_in())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            for t in done:
                if not t.cancelled() and t.exception():
                    log.warning("terminal pump error: %s", t.exception())
        finally:
            stop.set()
            self.shell.stop()
            log.info("terminal session %s ended", self.session.id)
            self.on_done(self.session.id)

    def _control(self, payload: bytes) -> None:
        try:
            msg = json.loads(payload.decode() or "{}")
        except (ValueError, UnicodeDecodeError):
            return
        if msg.get("t") == "resize":
            self.shell.resize(int(msg.get("cols", 80)), int(msg.get("rows", 24)))

    @staticmethod
    def _translate(data: bytes, echo: bool) -> bytes:
        """Byte translation for pipe-mode shells: CR -> CRLF, echo backspace."""
        out = bytearray()
        for b in data:
            if b == 0x0D:
                out += b"\r\n"
            elif b == 0x7F or b == 0x08:
                if echo:
                    out += b"\b \b"
                # dropped from stdin — pipe shells don't line-edit
            else:
                out.append(b)
        return bytes(out)


class DesktopWorker:
    """mss capture thread -> bounded frame queue -> WS; WS JSON -> input."""

    def __init__(self, ws, session: SessionInfo, on_done, monitor: int,
                 fps: int, quality: int):
        self.ws = ws
        self.session = session
        self.on_done = on_done
        self.backend = DesktopBackend(monitor, quality)
        self.fps = fps

    async def run(self) -> None:
        if not self.backend.probe():
            await self.ws.send(ctrl({"t": "bye", "reason": self.backend.error}))
            await self.ws.close()
            self.on_done(self.session.id)
            return

        loop = asyncio.get_running_loop()
        stop = threading.Event()
        # Size 2 + drop-oldest: slow networks degrade fps, never block capture
        frame_q: queue_DropOldest = queue_DropOldest(2)

        try:
            # executor thread: portal negotiation on Wayland can block for
            # up to 90 s waiting for the first-run consent dialog
            await loop.run_in_executor(None, self.backend.open)
        except Exception as e:
            await self.ws.send(ctrl({
                "t": "bye",
                "reason": f"screen capture unavailable: {e}"}))
            await self.ws.close()
            self.on_done(self.session.id)
            return
        w, h = self.backend.size
        await self.ws.send(ctrl({"t": "hello", "mode": "desktop", "width": w, "height": h}))

        interval = 1.0 / max(1, self.fps)

        def capturer():
            beat = time.monotonic()
            failures = 0
            sent = 0
            byte_total = 0
            stat_window = time.monotonic() + 5.0
            # Force a full-frame resend even on an unchanged screen so the
            # browser canvas recovers after reconnect or when desktop is static.
            FORCE_REFRESH_SECS = 2.0
            force_refresh_at = time.monotonic() + FORCE_REFRESH_SECS
            last_jpeg: bytes | None = None
            while not stop.is_set():
                now = time.monotonic()
                force = now >= force_refresh_at
                try:
                    jpeg = self.backend.capture_jpeg()
                except Exception:
                    jpeg = None
                if jpeg:
                    failures = 0
                    last_jpeg = jpeg
                    force_refresh_at = now + FORCE_REFRESH_SECS
                elif force and last_jpeg:
                    # Screen unchanged but we need a keepalive frame
                    jpeg = last_jpeg
                    force_refresh_at = now + FORCE_REFRESH_SECS
                if jpeg:
                    sent += 1
                    byte_total += len(jpeg)
                    frame_q.put(jpeg)
                    if sent == 1:
                        w, h = self.backend.size
                        log.info("first frame %dx%d, %d KB", w, h, len(jpeg) // 1024)
                else:
                    failures += 1 if self.backend.capture_broken else 0
                    if failures > 30:
                        frame_q.put(b"")
                        return
                now = time.monotonic()
                if now >= stat_window:
                    fps = sent / 5.0
                    avg = (byte_total // 1024) // max(sent, 1)
                    log.info("stream: %.1f fps, ~%d KB/frame", fps, avg)
                    sent = 0
                    byte_total = 0
                    stat_window = now + 5.0
                beat += interval
                delay = beat - time.monotonic()
                if delay > 0:
                    stop.wait(delay)
                else:
                    beat = time.monotonic()  # fell behind — reset cadence

        thread = threading.Thread(target=capturer, daemon=True,
                                  name=f"cap-{self.session.id[:8]}")
        thread.start()

        async def pump_out():
            while True:
                jpeg = await loop.run_in_executor(None, frame_q.get)
                if jpeg == b"":
                    await self.ws.send(ctrl({
                        "t": "bye", "reason": "screen capture stopped"}))
                    await self.ws.close()
                    return
                await self.ws.send(bytes([TAG_JPEG]) + jpeg)

        async def pump_in():
            async for msg in self.ws:
                if isinstance(msg, bytes) and msg:
                    tag, payload = msg[0], msg[1:]
                    if tag == TAG_CTRL:
                        try:
                            ev = json.loads(payload.decode())
                        except (ValueError, UnicodeDecodeError):
                            continue
                        if ev.get("t") == "quality":
                            self.backend.set_quality(int(ev.get("q", 60)))
                        else:
                            await loop.run_in_executor(
                                None, self.backend.apply_event, ev)

        try:
            done, pending = await asyncio.wait(
                [asyncio.create_task(pump_out()), asyncio.create_task(pump_in())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            for t in done:
                if not t.cancelled() and t.exception():
                    log.warning("desktop pump error: %s", t.exception())
        finally:
            stop.set()
            self.backend.close()
            log.info("desktop session %s ended", self.session.id)
            self.on_done(self.session.id)


class queue_DropOldest:
    """Thread-safe bounded queue: when full, drop the oldest item.

    Built on the stdlib queue.Queue so `get()` blocks safely inside an
    executor thread (an asyncio.Queue here would need the event loop).
    """

    def __init__(self, maxsize: int):
        self._q = queue.Queue(maxsize=maxsize)

    def put(self, item) -> None:
        try:
            self._q.put_nowait(item)
        except queue.Full:
            try:
                self._q.get_nowait()  # drop stale frame
            except queue.Empty:
                pass
            try:
                self._q.put_nowait(item)
            except queue.Full:
                pass

    def get(self):
        """Blocking; intended for run_in_executor."""
        return self._q.get()


# --------------------------------------------------------------------------
# control plane client
# --------------------------------------------------------------------------

class ControlClient:
    """HTTP + WebSocket client for the agent-facing API."""

    def __init__(self, server: str, agent_id: str):
        self.server = server.rstrip("/")
        self.agent_id = agent_id
        self.ws_base = server.replace("http", "ws", 1).replace("https", "wss", 1)

    def _url(self, path: str) -> str:
        return f"{self.server}{path}"

    def _request(self, path: str, method: str = "GET",
                 body: Optional[dict] = None, timeout: float = 8.0) -> Optional[dict]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self._url(path), data=data, method=method,
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                payload = res.read()
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise RuntimeError(f"unknown agent id {self.agent_id!r} — "
                                   f"register this host first") from e
            raise
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise ConnectionError(str(e)) from e

    # -- HTTP ---------------------------------------------------------------
    def heartbeat(self) -> dict:
        return self._request("/api/v1/agent/heartbeat", "POST",
                             {"agent_id": self.agent_id})
    def active_sessions(self) -> list[SessionInfo]:
        rows = self._request(
            f"/api/v1/agent/sessions?agent_id={self.agent_id}")["sessions"]
        return [SessionInfo(r["id"], r["host_id"], r["session_type"], r["status"])
                for r in rows]

    # -- WebSocket ------------------------------------------------------------
    def session_ws(self, session_id: str):
        return websockets.connect(
            f"{self.ws_base}/api/v1/ws/agent/{self.agent_id}", **WS_KWARGS)


# --------------------------------------------------------------------------
# agent supervisor
# --------------------------------------------------------------------------

class Agent:
    # minimum seconds between attach attempts for the same session id
    ATTACH_RETRY_SECONDS = 5.0

    def __init__(self, cfg):
        self.cfg = cfg
        self.control = ControlClient(cfg.server, cfg.agent_id)
        self.workers: dict[str, asyncio.Task] = {}
        self._last_attach: dict[str, float] = {}
        self.shutdown = asyncio.Event()

    # -- lifecycle ------------------------------------------------------------
    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        for sig in (_for_posix(signal.SIGINT, signal.SIGTERM)):
            if sig is None:
                continue
            try:
                loop.add_signal_handler(sig, self.shutdown.set)
            except (NotImplementedError, RuntimeError):
                pass  # Windows: handled by KeyboardInterrupt below

        log.info("pam_agent v%s | agent %s -> %s (terminal=%s desktop=%s)",
                 AGENT_VERSION, self.cfg.agent_id, self.cfg.server,
                 not self.cfg.no_terminal, not self.cfg.no_desktop)

        tasks = [
            asyncio.create_task(self._heartbeat_loop(), name="heartbeat"),
            asyncio.create_task(self._poll_loop(), name="poller"),
        ]
        try:
            await self.shutdown.wait()
        except KeyboardInterrupt:
            pass
        finally:
            for t in tasks:
                t.cancel()
            await self._stop_all_workers()
            await loop.run_in_executor(None, self._offline, 3.0)
            log.info("agent stopped cleanly")

    def _offline(self, timeout: float = 3.0) -> None:
        """Best-effort final offline heartbeat (swallowed on failure)."""
        try:
            self.control._request(
                "/api/v1/agent/offline", "POST",
                {"agent_id": self.agent_id}, timeout=timeout)
        except Exception:
            pass

    # -- loops ------------------------------------------------------------
    async def _heartbeat_loop(self) -> None:
        backoff = 1.0
        unknown_warned = False
        while not self.shutdown.is_set():
            try:
                res = await asyncio.get_running_loop().run_in_executor(
                    None, self.control.heartbeat)
                if not res.get("ok"):
                    if not unknown_warned:
                        log.error(
                            "agent id %r is NOT registered — register this "
                            "host in the PAM UI (Hosts -> Register Host) with "
                            "this exact agent id; it will go online "
                            "automatically once registered",
                            self.cfg.agent_id,
                        )
                        unknown_warned = True
                else:
                    if unknown_warned:
                        log.info("agent id %r now registered — online",
                                 self.cfg.agent_id)
                    unknown_warned = False
                backoff = 1.0
                await asyncio.sleep(HEARTBEAT_INTERVAL)
            except ConnectionError as e:
                log.warning("server unreachable (%s) — retrying in %.0fs",
                            e, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
            except RuntimeError as e:
                log.error("%s — exiting", e)
                self.shutdown.set()
                return
            except Exception:
                log.exception("heartbeat crashed")
                await asyncio.sleep(5)

    async def _poll_loop(self) -> None:
        while not self.shutdown.is_set():
            try:
                sessions = await asyncio.get_running_loop().run_in_executor(
                    None, self.control.active_sessions)
                self._reconcile(sessions)
            except ConnectionError:
                pass  # heartbeat loop already logs connectivity
            except Exception:
                log.exception("poll crashed")
            await asyncio.sleep(POLL_INTERVAL)

    def _reconcile(self, sessions: list[SessionInfo]) -> None:
        now = time.monotonic()
        # start workers for new active sessions
        for s in sessions:
            if s.id in self.workers or s.status != "active":
                continue
            # throttle crash loops: at most one attach attempt per session
            # every ATTACH_RETRY_SECONDS
            if now - self._last_attach.get(s.id, 0) < self.ATTACH_RETRY_SECONDS:
                continue
            if s.session_type == "rdp":
                if self.cfg.no_desktop:
                    continue
            elif self.cfg.no_terminal:
                continue
            if len(self.workers) >= self.cfg.max_sessions:
                log.warning("max concurrent sessions reached — skipping %s", s.id)
                continue
            self._last_attach[s.id] = now
            task = asyncio.create_task(self._run_session(s), name=f"sess-{s.id[:8]}")
            self.workers[s.id] = task
            log.info("attached to %s session %s", s.session_type, s.id)

        # reap finished
        for sid in [sid for sid, t in self.workers.items() if t.done()]:
            self.workers.pop(sid, None)

    async def _run_session(self, session: SessionInfo) -> None:
        try:
            async with self.control.session_ws(session.id) as ws:
                await ws.send(session.id)  # first message binds the streams
                if session.session_type == "rdp":
                    worker = DesktopWorker(
                        ws, session, self._worker_done,
                        self.cfg.monitor, self.cfg.fps, self.cfg.quality)
                else:
                    worker = TerminalWorker(ws, session, self._worker_done)
                await worker.run()
        except (websockets.WebSocketException, OSError) as e:
            log.warning("session %s connection error: %s", session.id, e)
        except Exception:
            log.exception("session %s worker crashed", session.id)
        finally:
            self.workers.pop(session.id, None)

    def _worker_done(self, session_id: str) -> None:
        t = self.workers.pop(session_id, None)
        if t and not t.done():
            t.cancel()

    async def _stop_all_workers(self) -> None:
        tasks = [t for t in self.workers.values() if not t.done()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.workers.clear()


def _for_posix(*sigs):
    return sigs if os.name == "posix" else (None,)


# --------------------------------------------------------------------------
# entry
# --------------------------------------------------------------------------

def parse_args(argv=None):
    p = argparse.ArgumentParser(description="PAM infrastructure agent")
    p.add_argument("--server", required=True,
                   help="control plane base URL, e.g. http://10.0.0.2:8000")
    p.add_argument("--agent-id", required=True,
                   help="agent_id of the registered host")
    p.add_argument("--max-sessions", type=int, default=5)
    p.add_argument("--monitor", type=int, default=1,
                   help="screen to capture for desktop sessions (1 = primary)")
    p.add_argument("--fps", type=int, default=10,
                   help="desktop capture rate cap (default 10)")
    p.add_argument("--quality", type=int, default=60,
                   help="JPEG quality 30-90 (default 60)")
    p.add_argument("--no-desktop", action="store_true",
                   help="disable screen capture / input injection")
    p.add_argument("--no-terminal", action="store_true",
                   help="disable terminal sessions")
    p.add_argument("--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv=None) -> int:
    cfg = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if cfg.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")

    if os.name == "nt":
        # Proactor loop supports subprocess pipes reliably on Windows
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    try:
        asyncio.run(Agent(cfg).run())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
