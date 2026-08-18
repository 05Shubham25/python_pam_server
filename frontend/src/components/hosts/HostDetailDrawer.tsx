"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { X } from "lucide-react";
import { useApp } from "@/lib/app-store";
import { Button } from "@/components/ui/Button";
import { StatusBadge, HOST_STATUS_TONE } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { OS_LABEL, formatDuration, relativeTime, SESSION_TYPE_LABEL } from "@/lib/format";
import type { Host } from "@/lib/types";

export function HostDetailDrawer({
  host,
  now,
  onClose,
  onDelete,
}: {
  host: Host;
  now: number;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  const { sessions } = useApp();
  const [tab, setTab] = useState<"active" | "history">("active");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const hostSessions = sessions.filter((s) => s.host.id === host.id);
  const active = hostSessions.filter((s) => s.status === "active");
  const history = hostSessions
    .filter((s) => s.status !== "active")
    .sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );

  const rows = tab === "active" ? active : history;

  const meta: [string, string][] = [
    ["IP Address", host.ipAddress],
    ["Operating System", OS_LABEL[host.os]],
    ["Environment", host.environment],
    ["Agent ID", host.agentId],
    ["Registered", relativeTime(host.registeredAt, now)],
    ["Last Seen", relativeTime(host.lastSeen, now)],
  ];

  return (
    <>
      <AnimatePresence>
        <motion.aside
          key="drawer"
          initial={{ x: 440, opacity: 0.5 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 440, opacity: 0.5 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="fixed right-0 top-0 z-40 flex h-screen w-[400px] max-w-full flex-col border-l border-border bg-ocean shadow-2xl shadow-black/50"
        >
          <div className="flex items-start justify-between border-b border-border px-6 py-5">
            <div>
              <h2 className="font-mono text-lg font-semibold">{host.hostname}</h2>
              <div className="mt-2 flex items-center gap-3">
                <StatusBadge
                  tone={HOST_STATUS_TONE[host.status]}
                  pulse={host.status === "online"}
                >
                  {host.status}
                </StatusBadge>
                <span className="text-xs text-ink-secondary">
                  seen {relativeTime(host.lastSeen, now)}
                </span>
              </div>
            </div>
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-ink-secondary transition-colors hover:bg-border/40 hover:text-ink-primary"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            <section className="border-b border-border px-6 py-5">
              <p className="label-xs mb-3">Metadata</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                {meta.map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[11px] text-ink-secondary/70">{k}</dt>
                    <dd className="mt-0.5 font-mono text-[13px]">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="px-6 py-5">
              <div className="mb-4 flex gap-1 rounded-lg bg-abyss/60 p-1">
                {(["active", "history"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={clsx(
                      "flex-1 rounded-md py-1.5 text-xs font-medium capitalize transition-colors",
                      tab === t
                        ? "bg-raised text-ink-primary"
                        : "text-ink-secondary hover:text-ink-primary",
                    )}
                  >
                    {t === "active" ? `Active (${active.length})` : `History (${history.length})`}
                  </button>
                ))}
              </div>

              {rows.length === 0 ? (
                <p className="py-6 text-center text-xs text-ink-secondary/60">
                  No {tab} sessions
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {rows.map((s) => (
                    <li
                      key={s.id}
                      className="rounded-lg border border-border bg-raised px-4 py-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-medium">
                          {s.user.name}
                        </span>
                        <span className="font-mono text-[11px] text-ink-secondary">
                          {SESSION_TYPE_LABEL[s.type]}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-ink-secondary">
                        {formatDuration(s.startedAt, s.endedAt, now)} · started{" "}
                        {relativeTime(s.startedAt, now)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="border-t border-border px-6 py-4">
            <button
              onClick={() => setConfirmOpen(true)}
              className="text-sm font-medium text-danger/80 transition-colors hover:text-danger"
            >
              Delete Host
            </button>
          </div>
        </motion.aside>
      </AnimatePresence>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`Delete ${host.hostname}?`}
        width="max-w-md"
      >
        <p className="text-sm leading-relaxed text-ink-secondary">
          This removes the host from the control plane. The agent can be
          re-registered later. Active sessions will be terminated.
        </p>
        <div className="mt-5 flex justify-end gap-2.5">
          <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmOpen(false);
              onDelete(host.id);
            }}
          >
            Delete Host
          </Button>
        </div>
      </Modal>
    </>
  );
}
