"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  connectSequence,
  prompt,
  respond,
  type ShellContext,
} from "./ShellSim";

interface Props {
  user: string;
  hostname: string;
  /** Broker WebSocket URL. When absent, a local simulated shell runs instead. */
  wsUrl?: string | null;
  onReady?: () => void;
}

/** Binary frame tags — must stay in sync with agent/pam_agent.py */
const TAG_TTY = 0x01;
const TAG_CTRL = 0x02;

export function TerminalView({ user, hostname, wsUrl, onReady }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!holder.current) return;

    const t = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      fontSize: 14,
      cursorBlink: true,
      cursorStyle: "bar",
      theme: {
        background: "#050505",
        foreground: "#d5e2f0",
        cursor: "#0EA5E9",
        selectionBackground: "#0EA5E940",
        black: "#06090f",
        brightBlack: "#3a4a5e",
      },
      scrollback: 5000,
      convertEol: true,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(holder.current);

    const doFit = () => {
      // Guard: container must have real dimensions before FitAddon reads them
      if (holder.current && holder.current.offsetHeight > 0) {
        fit.fit();
      }
    };
    // Defer to next animation frame so the browser has finished layout
    const rafId = requestAnimationFrame(doFit);
    window.addEventListener("resize", doFit);

    let disposed = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let ws: WebSocket | null = null;
    const encoder = new TextEncoder();

    function writePrompt(ctx: ShellContext) {
      t.write("\r\n" + prompt(ctx));
    }

    if (wsUrl) {
      // ---- live broker connection ----
      t.writeln("\x1b[36m◈ PAM secure channel\x1b[0m");
      t.write("\x1b[2m Connecting to broker…\x1b[0m");
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        t.write("\r\n\x1b[31m Failed to open WebSocket\x1b[0m");
      }
      if (ws) {
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          t.write("\r\n\x1b[2m Channel established — streaming\x1b[0m\r\n");
          onReady?.();
          t.focus();
        };
        ws.onmessage = (ev) => {
          if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength === 0) return;
          const frame = new Uint8Array(ev.data);
          const tag = frame[0];
          const payload = frame.subarray(1);
          if (tag === TAG_TTY) {
            t.write(payload);
          } else if (tag === TAG_CTRL) {
            try {
              const msg = JSON.parse(new TextDecoder().decode(payload));
              if (msg.t === "bye") {
                t.write(`\r\n\x1b[2m — ${msg.reason ?? "session ended"} —\x1b[0m`);
              }
            } catch {
              /* malformed control frame — ignore */
            }
          }
        };
        ws.onclose = () => {
          if (!disposed) {
            t.write("\r\n\x1b[2m — broker disconnected —\x1b[0m");
          }
        };
        ws.onerror = () => {
          t.write("\r\n\x1b[31m Broker connection error\x1b[0m");
        };
        t.onData((data) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            // tag terminal bytes so control frames can share the pipe
            ws.send(new Uint8Array([TAG_TTY, ...encoder.encode(data)]));
          }
        });
        // initial size hint for the remote PTY
        t.onResize(({ cols, rows }) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            const ctrl = new TextEncoder().encode(
              JSON.stringify({ t: "resize", cols, rows }),
            );
            ws.send(new Uint8Array([TAG_CTRL, ...ctrl]));
          }
        });
      }
    } else {
      // ---- simulated shell (demo mode / no broker URL) ----
      const ctx: ShellContext = {
        user,
        hostname,
        cwd: `/home/${user}`,
      };
      let buffer = "";
      let connecting = true;

      const lines = connectSequence(ctx);
      let i = 0;
      t.writeln("\x1b[36m◈ PAM secure channel\x1b[0m");
      (function step() {
        if (disposed) return;
        if (i < lines.length) {
          t.writeln(lines[i++]);
          timers.push(setTimeout(step, 220));
        } else {
          connecting = false;
          t.write(prompt(ctx));
          onReady?.();
          t.focus();
        }
      })();

      t.onData((data) => {
        if (connecting) return;
        if (data === "\r") {
          const out = respond(ctx, buffer);
          if (buffer.trim() === "clear") {
            t.clear();
          } else if (out) {
            t.write("\r\n" + out);
          }
          buffer = "";
          writePrompt(ctx);
        } else if (data === "\u007f") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            t.write("\b \b");
          }
        } else if (data === "\u0003") {
          t.write("^C");
          buffer = "";
          writePrompt(ctx);
        } else if (data >= " ") {
          buffer += data;
          t.write(data);
        }
      });
    }

    term.current = t;
    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      timers.forEach(clearTimeout);
      window.removeEventListener("resize", doFit);
      ws?.close();
      t.dispose();
      term.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, hostname, wsUrl]);

  return <div ref={holder} className="h-full w-full bg-[#050505]" />;
}
