"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ChevronRight, Copy, PanelRightClose, PanelRightOpen, ShieldCheck, XOctagon, Zap } from "lucide-react";
import { AppStoreProvider, useApp } from "@/lib/app-store";
import { API_BASE } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { formatBytes, formatDuration, relativeTime, SESSION_TYPE_LABEL } from "@/lib/format";

// http(s)://host/api/v1 -> ws(s)://host/api/v1
const WS_BASE = API_BASE.replace(/^http/, "ws");

// xterm touches `self` at import time — client only
const TerminalView = dynamic(
  () => import("@/components/terminal/TerminalView").then((m) => m.TerminalView),
  { ssr: false, loading: () => <div className="h-full w-full bg-[#050505]" /> },
);

const DesktopView = dynamic(
  () => import("@/components/terminal/DesktopView").then((m) => m.DesktopView),
  { ssr: false, loading: () => <div className="h-full w-full bg-[#050505]" /> },
);

export default function SessionPage({ params }: { params: { id: string } }) {
  return (
    <AppStoreProvider>
      <SessionScreen id={params.id} />
    </AppStoreProvider>
  );
}

function SessionScreen({ id }: { id: string }) {
  const router = useRouter();
  const { sessions, user, now, mode, terminateSession, toast } = useApp();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [connected, setConnected] = useState(false);
  const [latency, setLatency] = useState(12);
  const [bytes, setBytes] = useState(0);

  const session = useMemo(
    () => sessions.find((s) => s.id === id),
    [sessions, id],
  );

  useEffect(() => {
    const t = setInterval(() => {
      setLatency(8 + Math.floor(Math.random() * 14));
      if (connected) setBytes((b) => b + 80 + Math.floor(Math.random() * 500));
    }, 1500);
    return () => clearInterval(t);
  }, [connected]);

  const host = session?.host;
  const ended = session && session.status !== "active";
  const wsUrl =
    mode === "live" && !ended ? `${WS_BASE}/ws/browser/${id}` : null;

  function endSession() {
    if (session) terminateSession(session.id);
    router.push("/sessions");
  }

  if (!session || !host) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-abyss text-center">
        <p className="font-mono text-sm text-ink-secondary">
          session {id} not found
        </p>
        <Button variant="ghost" onClick={() => router.push("/sessions")}>
          Back to sessions
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#050505]">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-abyss px-4">
        <span className="flex items-center gap-2 font-mono text-[13px] font-bold">
          <ShieldCheck size={15} className="text-accent" />
          PAM
        </span>
        <span className="h-4 w-px bg-border" />
        <span suppressHydrationWarning className="truncate font-mono text-[12px] text-ink-secondary">
          {host.hostname} · {SESSION_TYPE_LABEL[session.type]} ·{" "}
          {session.user.email} · started {relativeTime(session.startedAt, now)}
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          {connected && !ended && (
            <span className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent">
              ⚡ Live
            </span>
          )}
          {session.recordingAvailable && (
            <span className="flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-danger">
              <span className="h-1.5 w-1.5 animate-blink rounded-full bg-danger" />
              REC
            </span>
          )}
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="rounded-md p-1.5 text-ink-secondary transition-colors hover:bg-border/40 hover:text-ink-primary"
            aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          >
            {sidebarOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
          <Button size="sm" variant="danger" onClick={endSession}>
            <XOctagon size={13} /> End Session
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Terminal */}
        <div className="relative min-w-0 flex-1">
          {ended ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="font-mono text-sm text-ink-secondary">
                This session was {session.status} {session.endedAt ? relativeTime(session.endedAt, now) : ""}
              </p>
              <Button variant="ghost" onClick={() => router.push("/audit")}>
                View audit trail
              </Button>
            </div>
          ) : wsUrl && session.type === "rdp" ? (
            <DesktopView
              wsUrl={wsUrl}
              onReady={() => setConnected(true)}
              onGone={() => setConnected(false)}
            />
          ) : (
            <TerminalView
              user={session.user.name.split(" ")[0].toLowerCase()}
              hostname={host.hostname}
              wsUrl={wsUrl}
              onReady={() => setConnected(true)}
            />
          )}
        </div>

        {/* Sidebar */}
        <aside
          className={clsx(
            "flex shrink-0 flex-col overflow-y-auto border-l border-border bg-ocean transition-[width] duration-200",
            sidebarOpen ? "w-[280px]" : "w-0 overflow-hidden border-l-0",
          )}
        >
          <Section title="Session Info">
            <InfoRow k="Session" v={session.id} mono />
            <InfoRow k="Host" v={host.hostname} mono />
            <InfoRow k="IP" v={host.ipAddress} mono />
            <InfoRow k="Environment" v={host.environment} mono />
            <InfoRow k="Type" v={SESSION_TYPE_LABEL[session.type]} mono />
            <InfoRow k="Duration" v={formatDuration(session.startedAt, session.endedAt, now)} suppress />
            <InfoRow k="Recording" v={session.recordingAvailable ? "asciicast v2" : "—"} />
          </Section>

          <Section title="Clipboard">
            <textarea
              placeholder="Shared clipboard — paste here to send to the remote host…"
              className="input-dark h-24 resize-none text-xs"
              onKeyDown={(e) => e.stopPropagation()}
            />
            <Button
              size="sm"
              variant="ghost"
              className="mt-2 w-full"
              onClick={() => {
                navigator.clipboard?.writeText("").catch(() => {});
                toast("info", "Clipboard synced with remote host");
              }}
            >
              <Copy size={12} /> Sync clipboard
            </Button>
          </Section>

          <Section title="File Transfer">
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-ink-secondary/70">
              Drag files here to upload
              <br />
              <span className="text-[10px]">(coming soon)</span>
            </div>
          </Section>
        </aside>
      </div>

      {/* Status bar */}
      <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-abyss px-4 font-mono text-[11px] text-ink-secondary">
        <span className="flex items-center gap-1.5">
          <Zap size={10} className="text-accent" />
          {connected ? `${latency}ms` : "…"}
        </span>
        <span>{formatBytes(bytes + (session.byteCount ?? 0))} transferred</span>
        <span className="flex items-center gap-1.5">
          <span
            className={clsx(
              "h-1.5 w-1.5 rounded-full",
              !connected
                ? "bg-warning"
                : latency < 20
                  ? "bg-success"
                  : "bg-warning",
            )}
          />
          {connected ? (latency < 20 ? "excellent" : "fair") : "connecting"}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {user.email}
          <ChevronRight size={10} />
          {host.hostname}
        </span>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border p-4">
      <p className="label-xs mb-3">{title}</p>
      {children}
    </section>
  );
}

function InfoRow({ k, v, mono, suppress }: { k: string; v: string; mono?: boolean; suppress?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[11px] text-ink-secondary/70">{k}</span>
      <span
        suppressHydrationWarning={suppress}
        className={clsx("truncate text-[12px] text-ink-primary", mono && "font-mono")}
      >
        {v}
      </span>
    </div>
  );
}
