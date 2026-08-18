"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Eye, Play, XOctagon } from "lucide-react";
import { useApp } from "@/lib/app-store";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { StatusBadge, SESSION_STATUS_TONE } from "@/components/ui/Badge";
import {
  formatDateTime,
  formatDuration,
  relativeTime,
  SESSION_TYPE_LABEL,
} from "@/lib/format";

type Tab = "active" | "history";
const PAGE_SIZE = 8;

export default function SessionsPage() {
  const { sessions, now, terminateSession } = useApp();
  const [tab, setTab] = useState<Tab>("active");
  const [page, setPage] = useState(0);

  const active = sessions.filter((s) => s.status === "active");
  const history = useMemo(
    () =>
      sessions
        .filter((s) => s.status !== "active")
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        ),
    [sessions],
  );

  const pageCount = Math.max(1, Math.ceil(history.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const historyPage = history.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE,
  );

  const tabs: [Tab, string, number][] = [
    ["active", "Active", active.length],
    ["history", "History", history.length],
  ];

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Sessions"
        subtitle="Every privileged connection — live, past, and awaiting approval."
      />

      <div className="mb-5 flex gap-1 rounded-lg border border-border bg-ocean p-1 sm:w-fit">
        {tabs.map(([id, label, count]) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setPage(0);
            }}
            className={clsx(
              "flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors",
              tab === id
                ? "bg-raised text-ink-primary shadow-sm"
                : "text-ink-secondary hover:text-ink-primary",
            )}
          >
            {label}
            <span
              className={clsx(
                "rounded-full px-1.5 py-0.5 font-mono text-[10px]",
                tab === id ? "bg-accent/15 text-accent" : "bg-border/50 text-ink-secondary",
              )}
            >
              {count}
            </span>
          </button>
        ))}
      </div>

      {tab === "active" && (
        <div className="grid gap-4 md:grid-cols-2">
          {active.length === 0 && (
            <Card className="md:col-span-2">
              <EmptyState title="No active sessions" hint="Connect to a host to start one" />
            </Card>
          )}
          {active.map((s) => (
            <Card
              key={s.id}
              className="relative overflow-hidden border-l-4 border-l-accent p-5 transition-colors hover:border-accent/50"
            >
              <div className="flex items-center justify-between">
                <StatusBadge tone="active" pulse>
                  Active
                </StatusBadge>
                <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
                  {SESSION_TYPE_LABEL[s.type]}
                </span>
              </div>
              <div className="mt-4 flex items-center justify-between gap-4">
                <Link
                  href={`/sessions/${s.id}`}
                  className="truncate font-mono text-[15px] font-semibold transition-colors hover:text-accent"
                >
                  {s.host.hostname}
                </Link>
                <span className="shrink-0 text-xs text-ink-secondary">
                  {s.user.email}
                </span>
              </div>
              <p suppressHydrationWarning className="mt-1.5 text-xs text-ink-secondary">
                Started {relativeTime(s.startedAt, now)} ·{" "}
                {formatDuration(s.startedAt, null, now)} elapsed
              </p>
              <div className="mt-5 flex gap-2.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1 !text-danger hover:!border-danger/40 hover:!bg-danger/10"
                  onClick={() => terminateSession(s.id)}
                >
                  <XOctagon size={13} /> Terminate
                </Button>
                <Link href={`/sessions/${s.id}`} className="flex-1">
                  <Button size="sm" className="w-full">
                    <Eye size={13} /> Watch Live
                  </Button>
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab === "history" && (
        <Card>
          {history.length === 0 ? (
            <EmptyState title="No past sessions" />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      {["User", "Host", "Type", "Start", "End", "Duration", "Status", "Recording"].map(
                        (h) => (
                          <th key={h} className="px-5 py-3">
                            <span className="label-xs">{h}</span>
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {historyPage.map((s) => (
                      <tr key={s.id} className="transition-colors hover:bg-accent/[0.04]">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={s.user.name} size={22} />
                            <span className="text-[13px]">{s.user.name}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3 font-mono text-[13px] text-ink-secondary">
                          {s.host.hostname}
                        </td>
                        <td className="px-5 py-3 font-mono text-[12px] text-ink-secondary">
                          {SESSION_TYPE_LABEL[s.type]}
                        </td>
                        <td className="px-5 py-3 text-[13px] text-ink-secondary">
                          {formatDateTime(s.startedAt)}
                        </td>
                        <td className="px-5 py-3 text-[13px] text-ink-secondary">
                          {s.endedAt ? formatDateTime(s.endedAt) : "—"}
                        </td>
                        <td suppressHydrationWarning className="px-5 py-3 text-[13px] text-ink-secondary">
                          {formatDuration(s.startedAt, s.endedAt, now)}
                        </td>
                        <td className="px-5 py-3">
                          <StatusBadge tone={SESSION_STATUS_TONE[s.status]}>
                            {s.status}
                          </StatusBadge>
                        </td>
                        <td className="px-5 py-3">
                          {s.recordingAvailable ? (
                            <Link
                              href={`/audit?session=${s.id}`}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
                            >
                              <Play size={11} /> Playback
                            </Link>
                          ) : (
                            <span className="text-xs text-ink-secondary/40">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pageCount > 1 && (
                <div className="flex items-center justify-between border-t border-border px-5 py-3">
                  <span className="text-xs text-ink-secondary">
                    Page {safePage + 1} of {pageCount}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={safePage === 0}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      <ChevronLeft size={14} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={safePage >= pageCount - 1}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      <ChevronRight size={14} />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
