"use client";

import { useEffect, useRef, useState } from "react";
import { X, Play, Pause, RotateCcw } from "lucide-react";
import clsx from "clsx";
import type { AuditGroup } from "@/lib/types";
import { formatDuration, SESSION_TYPE_LABEL } from "@/lib/format";

interface Props {
  group: AuditGroup | null;
  onClose: () => void;
}

const SPEEDS = [0.5, 1, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

export function PlaybackModal({ group, onClose }: Props) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0–100
  const [speed, setSpeed] = useState<Speed>(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset state whenever a new group is opened
  useEffect(() => {
    if (group) {
      setPlaying(false);
      setProgress(0);
      setSpeed(1);
    }
  }, [group]);

  // Tick the progress bar when playing
  useEffect(() => {
    if (!playing || !group) return;
    intervalRef.current = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          setPlaying(false);
          return 100;
        }
        return p + speed * 0.5; // 0.5% per tick at 1× speed
      });
    }, 100);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, speed, group]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!group) return null;

  const { session } = group;
  const durationStr = formatDuration(session.startedAt, session.endedAt, Date.now());

  function handleReset() {
    setProgress(0);
    setPlaying(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-ocean shadow-2xl shadow-black/60"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-accent/10">
              <Play size={11} className="text-accent" />
            </span>
            <div>
              <p className="text-[13px] font-medium">
                {session.host.hostname}
                <span className="ml-2 font-mono text-[11px] text-ink-secondary">
                  {SESSION_TYPE_LABEL[session.type]}
                </span>
              </p>
              <p className="font-mono text-[11px] text-ink-secondary">
                {session.user.name} · {durationStr}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-secondary transition-colors hover:bg-white/5 hover:text-ink-primary"
            aria-label="Close playback"
          >
            <X size={15} />
          </button>
        </div>

        {/* Terminal replay area */}
        <div className="h-72 bg-[#050505] p-4 font-mono text-[13px] text-[#d5e2f0]">
          <p className="text-[#0EA5E9]">◈ PAM session replay</p>
          <p className="mt-1 text-ink-secondary/60">
            {session.host.hostname} · {session.user.email}
          </p>
          <p className="mt-4">
            <span className="text-[#10B981]">{session.user.name.split(" ")[0].toLowerCase()}@{session.host.hostname}</span>
            <span className="text-ink-secondary">:~$ </span>
            {progress > 5 && <span className="animate-pulse">_</span>}
          </p>
          {progress > 15 && (
            <p className="mt-1 text-ink-secondary/80">
              Last login: {new Date(session.startedAt).toUTCString()}
            </p>
          )}
          {progress > 30 && (
            <p className="mt-1">
              <span className="text-[#10B981]">{session.user.name.split(" ")[0].toLowerCase()}@{session.host.hostname}</span>
              <span className="text-ink-secondary">:~$ </span>
              <span>ls -la /var/log</span>
            </p>
          )}
          {progress > 45 && (
            <p className="mt-1 text-ink-secondary/70">total 128</p>
          )}
          {progress > 55 && (
            <p className="text-ink-secondary/70">
              drwxr-xr-x 2 root root 4096 {new Date(session.startedAt).toLocaleDateString()}
            </p>
          )}
          {progress > 70 && (
            <p className="mt-2">
              <span className="text-[#10B981]">{session.user.name.split(" ")[0].toLowerCase()}@{session.host.hostname}</span>
              <span className="text-ink-secondary">:~$ </span>
              {progress < 95 && <span className="animate-pulse">_</span>}
              {progress >= 95 && <span>exit</span>}
            </p>
          )}
          {progress >= 100 && (
            <p className="mt-2 text-ink-secondary/60">— session ended —</p>
          )}
        </div>

        {/* Controls */}
        <div className="border-t border-border bg-abyss/60 px-5 py-4">
          {/* Progress bar */}
          <div className="mb-4">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-accent transition-all duration-100"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-secondary">
              <span>{Math.round((progress / 100) * parseInt(durationStr))}s</span>
              <span>{durationStr}</span>
            </div>
          </div>

          {/* Buttons row */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleReset}
              className="rounded-lg p-2 text-ink-secondary transition-colors hover:bg-white/5 hover:text-ink-primary"
              aria-label="Restart"
            >
              <RotateCcw size={14} />
            </button>

            <button
              onClick={() => setPlaying((p) => !p)}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white transition-opacity hover:opacity-90"
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>

            {/* Speed selector */}
            <div className="ml-auto flex items-center gap-1">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={clsx(
                    "rounded px-2.5 py-1 font-mono text-[11px] transition-colors",
                    speed === s
                      ? "bg-accent/20 text-accent"
                      : "text-ink-secondary hover:text-ink-primary",
                  )}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
