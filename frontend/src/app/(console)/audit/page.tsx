"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import clsx from "clsx";
import { ChevronDown, Server, User } from "lucide-react";
import { useApp } from "@/lib/app-store";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { StatusBadge, SESSION_STATUS_TONE } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Field } from "@/components/ui/Modal";
import {
  formatDateTime,
  formatDuration,
  SESSION_TYPE_LABEL,
} from "@/lib/format";
import type { Session } from "@/lib/types";

export default function AuditPage() {
  return (
    <Suspense fallback={null}>
      <AuditContent />
    </Suspense>
  );
}

function AuditContent() {
  const { sessions, now, mode } = useApp();
  const searchParams = useSearchParams();
  const focusSession = searchParams.get("session");

  const [userFilter, setUserFilter] = useState("all");
  const [hostFilter, setHostFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    if (focusSession) return new Set([focusSession]);
    return new Set<string>();
  });

  const past = useMemo(
    () =>
      sessions
        .filter((s) => s.status !== "active")
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        ),
    [sessions],
  );

  const users = useMemo(
    () => [...new Set(past.map((s) => s.user.name))].sort(),
    [past],
  );
  const hostnames = useMemo(
    () => [...new Set(past.map((s) => s.host.hostname))].sort(),
    [past],
  );

  const filtered = past.filter((s) => {
    if (userFilter !== "all" && s.user.name !== userFilter) return false;
    if (hostFilter !== "all" && s.host.hostname !== hostFilter) return false;
    if (typeFilter !== "all" && s.type !== typeFilter) return false;
    if (statusFilter !== "all" && s.status !== statusFilter) return false;
    return true;
  });

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Audit & Recordings"
        subtitle="Every privileged session on record, straight from the control plane."
      />

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        {/* Filters */}
        <Card className="h-fit p-5">
          <p className="label-xs mb-4">Filters</p>
          <div className="space-y-4">
            <Field label="User">
              <select
                className="input-dark"
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
              >
                <option value="all">All users</option>
                {users.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </Field>
            <Field label="Host">
              <select
                className="input-dark"
                value={hostFilter}
                onChange={(e) => setHostFilter(e.target.value)}
              >
                <option value="all">All hosts</option>
                {hostnames.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </Field>
            <Field label="Session type">
              <select
                className="input-dark"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">All types</option>
                <option value="ssh">SSH</option>
                <option value="rdp">RDP</option>
              </select>
            </Field>
            <Field label="Status">
              <select
                className="input-dark"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">All statuses</option>
                <option value="closed">Closed</option>
                <option value="denied">Denied</option>
              </select>
            </Field>
          </div>
        </Card>

        {/* Session records */}
        <div className="space-y-4">
          {filtered.length === 0 && (
            <Card>
              <EmptyState
                title={mode === "offline" ? "Backend unreachable" : "No session records"}
                hint={
                  mode === "offline"
                    ? "Check that the server is running"
                    : "Completed sessions appear here"
                }
              />
            </Card>
          )}

          {filtered.map((s) => {
            const open = expanded.has(s.id);
            return (
              <Card key={s.id} className="overflow-hidden">
                <button
                  onClick={() => toggle(s.id)}
                  className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-accent/[0.03]"
                >
                  <ChevronDown
                    size={15}
                    className={clsx(
                      "shrink-0 text-ink-secondary transition-transform duration-200",
                      open && "rotate-180",
                    )}
                  />
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1.5">
                    <span className="font-mono text-[13px] font-medium">
                      {s.host.hostname}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
                      <User size={11} /> {s.user.name}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-secondary">
                      <Server size={11} /> {SESSION_TYPE_LABEL[s.type]}
                    </span>
                    <span className="text-xs text-ink-secondary">
                      {formatDateTime(s.startedAt)} ·{" "}
                      {formatDuration(s.startedAt, s.endedAt, now)}
                    </span>
                  </div>
                  <StatusBadge tone={SESSION_STATUS_TONE[s.status]}>
                    {s.status}
                  </StatusBadge>
                </button>

                {open && <SessionDetail session={s} now={now} />}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SessionDetail({ session: s, now }: { session: Session; now: number }) {
  const rows: [string, React.ReactNode][] = [
    ["Session ID", <span key="id" className="font-mono text-[12px]">{s.id}</span>],
    ["User", `${s.user.name} · ${s.user.email}`],
    ["Host", `${s.host.hostname} (${s.host.ipAddress}, ${s.host.environment})`],
    ["Type", SESSION_TYPE_LABEL[s.type]],
    ["Started", formatDateTime(s.startedAt)],
    ["Ended", s.endedAt ? formatDateTime(s.endedAt) : "—"],
    ["Duration", formatDuration(s.startedAt, s.endedAt, now)],
    [
      "Recording",
      s.recordingAvailable ? (
        <span className="text-success">available</span>
      ) : (
        <span className="text-ink-secondary/60">none</span>
      ),
    ],
  ];

  return (
    <div className="border-t border-border">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-3">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] text-ink-secondary/70">{k}</dt>
            <dd className="mt-0.5 truncate text-[13px]">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center gap-3 border-t border-border bg-abyss/40 px-5 py-3">
        <Avatar name={s.user.name} size={20} />
        <p className="text-[11px] text-ink-secondary/70">
          Detailed per-keystroke audit events and playback arrive with the
          recording pipeline.
        </p>
      </div>
    </div>
  );
}
