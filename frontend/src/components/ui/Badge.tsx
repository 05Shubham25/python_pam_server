import clsx from "clsx";
import type { ReactNode } from "react";
import type { HostStatus, SessionStatus } from "@/lib/types";

type BadgeTone = "online" | "offline" | "active" | "pending" | "denied" | "closed" | "neutral" | "rec";

const TONE: Record<BadgeTone, string> = {
  online: "bg-success/10 text-success",
  offline: "bg-ink-secondary/10 text-ink-secondary",
  active: "bg-accent/10 text-accent",
  pending: "bg-warning/10 text-warning",
  denied: "bg-danger/10 text-danger",
  closed: "bg-ink-secondary/10 text-ink-secondary",
  neutral: "bg-ink-secondary/10 text-ink-secondary",
  rec: "bg-danger/10 text-danger",
};

export const HOST_STATUS_TONE: Record<HostStatus, BadgeTone> = {
  online: "online",
  offline: "offline",
  busy: "pending",
};

export const SESSION_STATUS_TONE: Record<SessionStatus, BadgeTone> = {
  active: "active",
  closed: "closed",
  denied: "denied",
};

export function StatusBadge({
  tone,
  pulse,
  children,
}: {
  tone: BadgeTone;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide",
        TONE[tone],
      )}
    >
      <span
        className={clsx(
          "h-1.5 w-1.5 rounded-full bg-current",
          pulse && "animate-blink",
        )}
      />
      {children}
    </span>
  );
}
