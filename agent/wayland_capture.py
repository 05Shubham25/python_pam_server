"""
wayland_capture.py — Wayland-native screen capture for the PAM agent.

Uses the xdg-desktop-portal ScreenCast API to negotiate a PipeWire stream
(same mechanism as OBS/Zoom/Firefox screen sharing), then pulls frames
through GStreamer's pipewiresrc into an appsink.

Consent behaviour (an OS security boundary — cannot be bypassed):
  * FIRST RUN: compositor shows a "Share your screen?" dialog; on Allow we
    receive and save a restore_token (~/.pam_agent/wayland_restore_token.json).
  * LATER RUNS: the saved token is passed back; GNOME 42+/KDE 5.27+ skip
    the dialog entirely (unattended).
  * If permission is revoked in system settings the token dies and one
    dialog reappears.

This module imports ONLY the stdlib at module level, so it is safe to ship
and import on Windows/macOS/plain X11 — every platform-specific import is
deferred and availability is reported via portal_available().

Dependencies (Ubuntu/Debian):
    sudo apt install python3-gi gir1.2-gstreamer-1.0 \\
        gstreamer1.0-plugins-base gstreamer1.0-plugins-good \\
        gstreamer1.0-pipewire
    pip install dbus-next
NOTE: python3-gi installs into the SYSTEM python. If the agent runs inside
a venv, create it with `--system-site-packages` (or pip-install PyGObject
in the venv) or `import gi` will fail inside the venv.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from pathlib import Path
from typing import Optional, Tuple

log = logging.getLogger("pam-agent.wayland")

TOKEN_FILE = Path.home() / ".pam_agent" / "wayland_restore_token.json"
PORTAL_BUS_NAME = "org.freedesktop.portal.Desktop"
PORTAL_OBJECT_PATH = "/org/freedesktop/portal/desktop"

# Just the Request interface (Response signal) — enough to subscribe to a
# request object BEFORE invoking the portal method, avoiding the classic
# "response arrived before we subscribed" race.
REQUEST_XML = (
    "<node>"
    '  <interface name="org.freedesktop.portal.Request">'
    '    <signal name="Response">'
    '      <arg name="response" type="u" direction="out"/>'
    '      <arg name="results" type="a{sv}" direction="out"/>'
    "    </signal>"
    "  </interface>"
    "</node>"
)

MATCH_RULE = (
    "type='signal',"
    f"sender='{PORTAL_BUS_NAME}',"
    "interface='org.freedesktop.portal.Request',"
    "path='{path}'"
)

APT_HINT = (
    "Wayland capture needs PyGObject + GStreamer + dbus-next:\n"
    "  sudo apt install python3-gi gir1.2-gstreamer-1.0 \\\n"
    "       gstreamer1.0-plugins-base gstreamer1.0-plugins-good \\\n"
    "       gstreamer1.0-pipewire\n"
    "  pip install dbus-next\n"
    "NOTE: python3-gi installs into the SYSTEM python — if the agent runs in\n"
    "a venv, recreate it with --system-site-packages (or pip install PyGObject)."
)


def is_wayland() -> bool:
    """True on a Wayland session. WAYLAND_DISPLAY is checked too because
    XDG_SESSION_TYPE is often unset when the agent is launched via SSH."""
    return (
        os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland"
        or bool(os.environ.get("WAYLAND_DISPLAY"))
    )


def portal_available() -> Tuple[bool, str]:
    """Check the optional deps without importing them for real work."""
    try:
        import gi  # noqa: F401
        gi.require_version("Gst", "1.0")
        from gi.repository import Gst  # noqa: F401,F403
    except Exception:
        return False, APT_HINT
    try:
        import dbus_next  # noqa: F401
    except ImportError:
        return False, "dbus-next missing — pip install dbus-next\n" + APT_HINT
    return True, ""


def _load_restore_token() -> Optional[str]:
    try:
        return json.loads(TOKEN_FILE.read_text()).get("restore_token")
    except (OSError, ValueError):
        return None


def _save_restore_token(token: str) -> None:
    try:
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(json.dumps({"restore_token": token}))
    except OSError:
        pass  # token persistence is best-effort


def _request_path(unique_name: str, handle_token: str) -> str:
    """Predict the request object path per the portal spec so the Response
    signal can be subscribed before the method call."""
    escaped = unique_name.replace(":", "_").replace(".", "_")
    return f"/org/freedesktop/portal/desktop/request/{escaped}/{handle_token}"


class WaylandPortalCapture:
    """One portal-negotiated PipeWire screen stream.

    JPEG encoding happens INSIDE the GStreamer pipeline (jpegenc —
    libjpeg-turbo speed, on a native thread), so Python only ever touches
    already-encoded frames. That is what makes 30+ fps achievable.
    """

    def __init__(self, quality: int = 60):
        self._quality = quality
        self._node_id: Optional[int] = None
        self._pipeline = None
        self._encoder = None
        self._bus = None  # kept alive: closing it can revoke stream access
        self._latest: Optional[Tuple[bytes, int, int]] = None
        self._lock = threading.Lock()
        self._first_frame = threading.Event()
        self._size = (0, 0)

    def set_quality(self, quality: int) -> None:
        self._quality = max(30, min(90, quality))
        if self._encoder is not None:
            try:
                self._encoder.set_property("quality", self._quality)
            except Exception:
                pass

    # ------------------------------------------------------------------ D-Bus

    async def _negotiate(self) -> None:
        """Portal negotiation over RAW D-Bus messages.

        The high-level dbus-next proxy is deliberately NOT used: newer
        xdg-desktop-portal versions expose property names containing dashes
        (e.g. power-saver-enabled) which the proxy's member-name machinery
        rejects with "invalid member name". Low-level Message objects never
        go through that conversion.
        """
        from dbus_next import Message, MessageType, Variant
        from dbus_next.aio import MessageBus

        bus = await MessageBus().connect()
        self._bus = bus

        sender = f"pam_agent_{os.getpid()}"
        loop = asyncio.get_running_loop()

        async def portal_call(member: str, signature: str, body: list,
                              handle_token: str):
            """Invoke a ScreenCast method and await its Response signal,
            subscribed before the call (race-safe)."""
            path = _request_path(bus.unique_name, handle_token)
            fut = loop.create_future()

            def on_message(msg):
                if (
                    msg.message_type == MessageType.SIGNAL
                    and msg.member == "Response"
                    and msg.path == path
                    and not fut.done()
                ):
                    fut.set_result(msg.body)

            bus.add_message_handler(on_message)
            # dbus-next has no add_match() helper — send the raw DBus call.
            await bus.call(Message(
                destination="org.freedesktop.DBus",
                path="/org/freedesktop/DBus",
                interface="org.freedesktop.DBus",
                member="AddMatch",
                signature="s",
                body=[MATCH_RULE.format(path=path)],
            ))

            options = body[-1]  # the options dict is always the last arg
            options["handle_token"] = Variant("s", handle_token)

            reply = await bus.call(Message(
                destination=PORTAL_BUS_NAME,
                path=PORTAL_OBJECT_PATH,
                interface="org.freedesktop.portal.ScreenCast",
                member=member,
                signature=signature,
                body=body,
            ))
            if reply.message_type == MessageType.ERROR:
                raise RuntimeError(f"portal {member} error: {reply.error_name}")
            return await fut

        # 1. CreateSession
        code, results = await portal_call(
            "CreateSession", "a{sv}",
            [{"session_handle_token": Variant("s", f"{sender}_session")}],
            f"{sender}_create",
        )
        if code != 0:
            raise RuntimeError(f"portal CreateSession denied (code {code})")
        session_handle = results["session_handle"].value

        # 2. SelectSources — monitor, persist permission, reuse saved token
        select_opts = {
            "types": Variant("u", 1),          # 1 = MONITOR
            "multiple": Variant("b", False),
            "persist_mode": Variant("u", 2),   # 2 = persist until revoked
        }
        saved = _load_restore_token()
        if saved:
            select_opts["restore_token"] = Variant("s", saved)
        code, _ = await portal_call(
            "SelectSources", "oa{sv}",
            [session_handle, select_opts],
            f"{sender}_select",
        )
        if code != 0:
            raise RuntimeError(f"portal SelectSources denied (code {code})")

        # 3. Start — triggers the consent dialog on the first run only
        code, results = await portal_call(
            "Start", "osa{sv}",
            [session_handle, "", {}],
            f"{sender}_start",
        )
        if code != 0:
            raise RuntimeError(
                f"portal Start denied (code {code}) — user declined or the "
                "saved restore_token expired")

        streams = results["streams"].value
        self._node_id = int(streams[0][0])

        new_token = results.get("restore_token")
        if new_token is not None:
            _save_restore_token(new_token.value)
            log.info("portal consent saved — future runs skip the dialog")

    def negotiate_blocking(self, timeout: float = 90.0) -> None:
        """Run the full negotiation. Blocks until the user answers the consent
        dialog (first run) or instantly (valid restore token). MUST be called
        from a plain thread (e.g. via run_in_executor), not the event loop."""
        asyncio.run(asyncio.wait_for(self._negotiate(), timeout=timeout))

    # -------------------------------------------------------------- GStreamer

    def start(self) -> None:
        if self._node_id is None:
            raise RuntimeError("negotiate before start()")

        import gi
        gi.require_version("Gst", "1.0")
        from gi.repository import Gst

        Gst.init(None)
        # jpegenc (libjpeg-turbo) encodes in the streaming thread — Python
        # never encodes, it only forwards finished JPEG frames.
        pipeline = Gst.parse_launch(
            f"pipewiresrc path={self._node_id} ! "
            f"videoconvert ! jpegenc name=enc quality={self._quality} ! "
            "image/jpeg ! appsink name=sink emit-signals=true max-buffers=2 drop=true"
        )
        self._encoder = pipeline.get_by_name("enc")
        sink = pipeline.get_by_name("sink")
        sink.connect("new-sample", self._on_sample)
        pipeline.set_state(Gst.State.PLAYING)
        self._pipeline = pipeline

    def _on_sample(self, sink):
        import gi
        gi.require_version("Gst", "1.0")
        from gi.repository import Gst

        sample = sink.emit("pull-sample")
        buf = sample.get_buffer()
        struct = sample.get_caps().get_structure(0)
        w, h = struct.get_value("width"), struct.get_value("height")
        ok, mapinfo = buf.map(Gst.MapFlags.READ)
        if ok:
            with self._lock:
                self._latest = (bytes(mapinfo.data), w, h)
                self._size = (w, h)
            buf.unmap(mapinfo)
            self._first_frame.set()
        return Gst.FlowReturn.OK

    # ---------------------------------------------------------------- public

    def wait_first_frame(self, timeout: float = 5.0) -> bool:
        return self._first_frame.wait(timeout)

    def get_latest_jpeg(self) -> Optional[Tuple[bytes, int, int]]:
        """Newest encoded JPEG frame as (jpeg_bytes, width, height)."""
        with self._lock:
            return self._latest

    @property
    def size(self) -> Tuple[int, int]:
        return self._size

    def stop(self) -> None:
        if self._pipeline is not None:
            import gi
            gi.require_version("Gst", "1.0")
            from gi.repository import Gst
            self._pipeline.set_state(Gst.State.NULL)
            self._pipeline = None
        if self._bus is not None:
            try:
                loop = asyncio.new_event_loop()
                loop.run_until_complete(self._bus.disconnect())  # type: ignore[attr-defined]
                loop.close()
            except Exception:
                pass
            self._bus = None
