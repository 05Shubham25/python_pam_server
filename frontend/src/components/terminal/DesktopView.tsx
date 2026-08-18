"use client";

import { useEffect, useRef, useState } from "react";

/** Binary frame tags — must stay in sync with agent/pam_agent.py */
const TAG_CTRL = 0x02;
const TAG_JPEG = 0x03;

const BUTTON_MAP: Record<number, number> = { 0: 1, 1: 2, 2: 3 };

/**
 * Live desktop view: agent streams tagged JPEG frames over the broker,
 * browser sends mouse/keyboard events back as tagged JSON control frames.
 */
export function DesktopView({
  wsUrl,
  onReady,
  onGone,
}: {
  wsUrl: string;
  onReady?: () => void;
  onGone?: (reason: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const wsRef = useRef<WebSocket | null>(null);
  const isLiveRef = useRef(false); // track live state without stale closure
  const [status, setStatus] = useState<"connecting" | "live" | "ended">(
    "connecting",
  );
  const [endReason, setEndReason] = useState("");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_RETRIES = 8;
    const encoder = new TextEncoder();
    // latest-frame-wins: never queue decodes — at 30+ fps a decode backlog
    // shows as lag; stale frames are dropped in favour of the newest
    let decoding = false;
    let pendingFrame: Uint8Array | null = null;

    async function drawFrame(payload: Uint8Array) {
      const cv = canvas!;
      const blob = new Blob([payload as unknown as BlobPart], {
        type: "image/jpeg",
      });
      const bmp = await createImageBitmap(blob);
      if (disposed) {
        bmp.close();
        return;
      }
      if (cv.width !== bmp.width || cv.height !== bmp.height) {
        cv.width = bmp.width;
        cv.height = bmp.height;
      }
      ctx!.drawImage(bmp, 0, 0);
      bmp.close();
      if (!isLiveRef.current) {
        isLiveRef.current = true;
        setStatus("live");
        cv.focus();
      }
    }

    function connect() {
      if (disposed) return;

      console.log(`[DesktopView] connecting (attempt ${retryCount + 1}) →`, wsUrl);
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        console.error("[DesktopView] WS constructor threw:", err);
        setStatus("ended");
        setEndReason("Failed to open WebSocket");
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[DesktopView] WS open");
        retryCount = 0; // reset backoff on successful connect
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(new Uint8Array([TAG_CTRL, ...encoder.encode('{"t":"hello"}')]));
        }
        onReady?.();
      };

      ws.onerror = (e) => {
        console.error("[DesktopView] WS error", e);
      };

      ws.onmessage = async (ev) => {
        if (disposed || !(ev.data instanceof ArrayBuffer) || ev.data.byteLength === 0)
          return;
        const frame = new Uint8Array(ev.data);
        const tag = frame[0];
        const payload = frame.subarray(1);

        if (tag === TAG_JPEG) {
          if (decoding) {
            pendingFrame = payload; // replace any older pending frame
            return;
          }
          decoding = true;
          try {
            await drawFrame(payload);
            while (!disposed && pendingFrame) {
              const next = pendingFrame;
              pendingFrame = null;
              await drawFrame(next);
            }
          } catch {
            /* partial frame — wait for the next one */
          } finally {
            decoding = false;
          }
        } else if (tag === TAG_CTRL) {
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload));
            if (msg.t === "hello") {
              screenRef.current = { w: msg.width ?? 0, h: msg.height ?? 0 };
              if (!isLiveRef.current) {
                isLiveRef.current = true;
                setStatus("live");
                canvas!.focus();
              }
            } else if (msg.t === "bye") {
              console.log("[DesktopView] received bye:", msg.reason);
              setStatus("ended");
              setEndReason(msg.reason ?? "session ended");
              onGone?.(msg.reason ?? "session ended");
            }
          } catch {
            /* malformed control frame */
          }
        }
      };

      ws.onclose = (e) => {
        console.log("[DesktopView] WS closed code=", e.code, "reason=", e.reason, "wasClean=", e.wasClean);
        wsRef.current = null;
        if (disposed) return;

        // If the server sent a clean bye (we set status=ended above), don't retry.
        // code 1000 = normal close, 1001 = going away (server restart)
        const serverEnded = e.code === 1000 && e.reason !== "";
        if (serverEnded) return;

        // Retry with exponential backoff unless we've maxed out.
        if (retryCount < MAX_RETRIES) {
          const delay = Math.min(1000 * 2 ** retryCount, 15000);
          retryCount++;
          console.log(`[DesktopView] reconnecting in ${delay}ms (attempt ${retryCount}/${MAX_RETRIES})`);
          setStatus("connecting");
          isLiveRef.current = false;
          retryTimer = setTimeout(connect, delay);
        } else {
          setStatus("ended");
          setEndReason("Connection lost — refresh to retry");
          onGone?.("Connection lost");
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]);


  /* ---- input translation: canvas coords -> agent screen coords ---- */
  function toScreen(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = screenRef.current.w
      ? e.currentTarget.clientWidth / screenRef.current.w
      : 1;
    return {
      x: Math.round((e.clientX - rect.left) / Math.max(scale, 0.001)),
      y: Math.round((e.clientY - rect.top) / Math.max(scale, 0.001)),
    };
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x, y } = toScreen(e);
    wsRefSend({ t: "mmove", x, y });
  }
  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x, y } = toScreen(e);
    wsRefSend({ t: "mdown", b: BUTTON_MAP[e.button] ?? 1, x, y });
  }
  function onMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x, y } = toScreen(e);
    wsRefSend({ t: "mup", b: BUTTON_MAP[e.button] ?? 1, x, y });
  }
  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    wsRefSend({ t: "mwheel", dy: Math.round(e.deltaY) });
  }
  function onDoubleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const { x, y } = toScreen(e);
    wsRefSend({ t: "mclick", b: BUTTON_MAP[e.button] ?? 1, clk: 2, x, y });
  }
  function onContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (e.key === "F11" || e.key === "F12") return; // keep browser escape hatches
    e.preventDefault();
    wsRefSend({ t: "key", key: e.key, mod: modList(e), down: true });
  }
  function onKeyUp(e: React.KeyboardEvent<HTMLCanvasElement>) {
    if (e.key === "F11" || e.key === "F12") return;
    e.preventDefault();
    wsRefSend({ t: "key", key: e.key, mod: modList(e), down: false });
  }

  function modList(e: React.KeyboardEvent | React.MouseEvent): string[] {
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("ctrl");
    if (e.altKey) mods.push("alt");
    if (e.shiftKey) mods.push("shift");
    if (e.metaKey) mods.push("meta");
    return mods;
  }

  function wsRefSend(obj: unknown) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const encoder = new TextEncoder();
      ws.send(new Uint8Array([TAG_CTRL, ...encoder.encode(JSON.stringify(obj))]));
    }
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-[#050505] p-2">
      {status !== "live" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[#050505]/80 text-center">
          <p className="font-mono text-sm text-ink-secondary">
            {status === "connecting" ? "Connecting to remote desktop…" : endReason}
          </p>
          {status === "connecting" && (
            <span className="h-1.5 w-1.5 animate-blink rounded-full bg-accent" />
          )}
        </div>
      )}
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className="max-h-full max-w-full cursor-crosshair rounded-md border border-border object-contain outline-none"
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      />
    </div>
  );
}
