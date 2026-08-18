"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronRight, Clock3, Server, Zap } from "lucide-react";
import { useApp } from "@/lib/app-store";
import { Card, CardHeader, EmptyState } from "@/components/ui/Card";
import { StatusBadge, SESSION_STATUS_TONE } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import {
  formatDuration,
  relativeTime,
  SESSION_TYPE_LABEL,
} from "@/lib/format";
import clsx from "clsx";

export default function DashboardPage() {
  const router = useRouter();
  const { user, hosts, sessions, now } = useApp();

  const onlineCount = hosts.filter((h) => h.status === "online").length;
  const activeSessions = sessions.filter((s) => s.status === "active");
  const dayAgo = now - 24 * 3600 * 1000;
  const sessionsToday = sessions.filter(
    (s) => new Date(s.startedAt).getTime() > dayAgo,
  ).length;
  const recent = [...sessions]
    .sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )
    .slice(0, 10);

  const hour = new Date(now).getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const utcClock = new Date(now)
    .toISOString()
    .slice(11, 19)
    .concat(" UTC");

  const stats = [
    { label: "Total Hosts", value: hosts.length, sub: "registered", dot: "bg-accent" },
    { label: "Online Now", value: onlineCount, sub: `${hosts.length - onlineCount} offline`, dot: "bg-success", live: true },
    { label: "Active Sessions", value: activeSessions.length, sub: "live", dot: "bg-accent", live: true },
    { label: "Sessions · 24h", value: sessionsToday, sub: "started today", dot: "bg-warning" },
  ];

  return (
    <div className="animate-fade-up">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 suppressHydrationWarning className="text-[28px] font-bold leading-tight tracking-tight">
            {greeting}, {user.name} <span className="text-accent">◈</span>
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Here&apos;s the state of your infrastructure.
          </p>
        </div>
        <div
          suppressHydrationWarning
          className="flex items-center gap-2 font-mono text-xs text-ink-secondary"
        >
          <Clock3 size={13} />
          {utcClock}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="relative overflow-hidden p-5">
            <span className={clsx("absolute left-0 top-5 h-8 w-[3px] rounded-r", s.dot)} />
            <p className="text-[32px] font-bold leading-none tracking-tight">
              {s.value}
            </p>
            <p className="label-xs mt-2.5">{s.label}</p>
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-secondary/80">
              {s.live && <span className="h-1.5 w-1.5 animate-blink rounded-full bg-current" />}
              {s.sub}
            </p>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Recent sessions */}
        <Card>
          <CardHeader
            title="Recent Sessions"
            action={
              <Link
                href="/sessions"
                className="flex items-center gap-1 text-xs text-ink-secondary transition-colors hover:text-accent"
              >
                View all <ChevronRight size={13} />
              </Link>
            }
          />
          {recent.length === 0 ? (
            <EmptyState title="No sessions yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-ink-secondary">
                    <th className="px-5 py-2.5 text-left"><span className="label-xs">User</span></th>
                    <th className="px-5 py-2.5 text-left"><span className="label-xs">Host</span></th>
                    <th className="px-5 py-2.5 text-left"><span className="label-xs">Type</span></th>
                    <th className="px-5 py-2.5 text-left"><span className="label-xs">Duration</span></th>
                    <th className="px-5 py-2.5 text-left"><span className="label-xs">Status</span></th>
                    <th className="px-5 py-2.5 text-left"><span className="label-xs">Started</span></th>
                    <th className="px-5 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {recent.map((s) => (
                    <tr
                      key={s.id}
                      className="group cursor-pointer transition-colors hover:bg-accent/[0.04]"
                      onClick={() => router.push(`/sessions/${s.id}`)}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={s.user.name} size={24} />
                          <span className="text-[13px]">{s.user.name}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3 font-mono text-[13px] text-ink-secondary">
                        {s.host.hostname}
                      </td>
                      <td className="px-5 py-3 font-mono text-[12px] text-ink-secondary">
                        {SESSION_TYPE_LABEL[s.type]}
                      </td>
                      <td suppressHydrationWarning className="px-5 py-3 text-[13px] text-ink-secondary">
                        {formatDuration(s.startedAt, s.endedAt, now)}
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge
                          tone={SESSION_STATUS_TONE[s.status]}
                          pulse={s.status === "active"}
                        >
                          {s.status}
                        </StatusBadge>
                      </td>
                      <td suppressHydrationWarning className="px-5 py-3 text-[13px] text-ink-secondary">
                        {relativeTime(s.startedAt, now)}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <ArrowRight
                          size={14}
                          className="ml-auto text-ink-secondary/40 transition-colors group-hover:text-accent"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Right column */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              title="Host Status"
              action={
                <Link
                  href="/hosts"
                  className="flex items-center gap-1 text-xs text-ink-secondary transition-colors hover:text-accent"
                >
                  <Server size={13} /> Manage
                </Link>
              }
            />
            <ul className="max-h-[280px] divide-y divide-border/60 overflow-y-auto">
              {hosts.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center gap-3 px-5 py-2.5"
                >
                  <span
                    className={clsx(
                      "h-2 w-2 shrink-0 rounded-full",
                      h.status === "online"
                        ? "animate-pulse-ring bg-success"
                        : "bg-ink-secondary/40",
                    )}
                  />
                  <span className="flex-1 truncate font-mono text-[13px]">
                    {h.hostname}
                  </span>
                  <span className="font-mono text-[11px] text-ink-secondary">
                    {h.ipAddress}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="flex items-center gap-4 border-accent/20 bg-accent/[0.04] p-5">
            <Zap size={18} className="shrink-0 text-accent" />
            <div className="flex-1">
              <p className="text-[13px] font-medium">Quick connect</p>
              <p className="text-xs text-ink-secondary">
                Start a session on any online host.
              </p>
            </div>
            <Link href="/hosts">
              <Button size="sm" variant="ghost">
                Connect
              </Button>
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
