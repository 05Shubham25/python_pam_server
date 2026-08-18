"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Monitor, Plus, Search, Terminal } from "lucide-react";
import { useApp } from "@/lib/app-store";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, EmptyState } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge, HOST_STATUS_TONE } from "@/components/ui/Badge";
import { Modal, Field } from "@/components/ui/Modal";
import { OS_LABEL } from "@/lib/format";
import type { Environment, Host, OS } from "@/lib/types";
import { HostDetailDrawer } from "@/components/hosts/HostDetailDrawer";

const OS_ICON: Record<OS, string> = {
  linux: "",
  windows: "🪟",
  macos: "🍎",
};

export default function HostsPage() {
  const router = useRouter();
  const { hosts, now, mode, addHost, removeHost, openSession, toast } = useApp();
  const [query, setQuery] = useState("");
  const [env, setEnv] = useState<Environment | "all">("all");
  const [os, setOs] = useState<OS | "all">("all");
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [selected, setSelected] = useState<Host | null>(null);

  const filtered = useMemo(
    () =>
      hosts.filter((h) => {
        const q = query.trim().toLowerCase();
        if (q && !h.hostname.toLowerCase().includes(q) && !h.ipAddress.includes(q))
          return false;
        if (env !== "all" && h.environment !== env) return false;
        if (os !== "all" && h.os !== os) return false;
        if (onlineOnly && h.status !== "online") return false;
        return true;
      }),
    [hosts, query, env, os, onlineOnly],
  );

  // keep drawer data fresh if the underlying host updates
  const selectedLive = selected
    ? hosts.find((h) => h.id === selected.id) ?? null
    : null;

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Hosts"
        subtitle={`${hosts.length} machines registered · ${hosts.filter((h) => h.status === "online").length} online`}
        actions={
          <Button onClick={() => setRegisterOpen(true)}>
            <Plus size={15} /> Register Host
          </Button>
        }
      />

      {/* Filter bar */}
      <Card className="mb-5 flex flex-wrap items-center gap-3 p-4">
        <div className="relative min-w-[220px] flex-1">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-secondary/60"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search hostname or IP…"
            className="input-dark pl-9"
          />
        </div>
        <select
          value={env}
          onChange={(e) => setEnv(e.target.value as typeof env)}
          className="input-dark w-auto"
        >
          <option value="all">All Environments</option>
          <option value="dev">dev</option>
          <option value="staging">staging</option>
          <option value="prod">prod</option>
        </select>
        <select
          value={os}
          onChange={(e) => setOs(e.target.value as typeof os)}
          className="input-dark w-auto"
        >
          <option value="all">All OS</option>
          <option value="linux">Linux</option>
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
        </select>
        <button
          onClick={() => setOnlineOnly((v) => !v)}
          className={clsx(
            "flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm transition-colors",
            onlineOnly
              ? "border-accent/50 bg-accent/10 text-ink-primary"
              : "border-border text-ink-secondary hover:text-ink-primary",
          )}
        >
          <span
            className={clsx(
              "relative h-4 w-7 rounded-full transition-colors",
              onlineOnly ? "bg-accent" : "bg-border",
            )}
          >
            <span
              className={clsx(
                "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
                onlineOnly ? "left-3.5" : "left-0.5",
              )}
            />
          </span>
          Online only
        </button>
      </Card>

      <Card>
        {filtered.length === 0 ? (
          <EmptyState title="No hosts match these filters" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  {["Hostname", "IP Address", "OS", "Environment", "Status", "Actions"].map(
                    (h) => (
                      <th key={h} className="px-5 py-3">
                        <span className="label-xs">{h}</span>
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filtered.map((h) => (
                  <tr
                    key={h.id}
                    onClick={() => setSelected(h)}
                    className="cursor-pointer transition-colors hover:bg-accent/[0.04]"
                  >
                    <td className="px-5 py-3.5 font-mono text-[13px] font-medium">
                      {h.hostname}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-[13px] text-ink-secondary">
                      {h.ipAddress}
                    </td>
                    <td className="px-5 py-3.5 text-[13px] text-ink-secondary">
                      <span className="mr-1.5">{OS_ICON[h.os]}</span>
                      {OS_LABEL[h.os]}
                    </td>
                    <td className="px-5 py-3.5">
                      <EnvTag env={h.environment} />
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge tone={HOST_STATUS_TONE[h.status]} pulse={h.status === "online"}>
                        {h.status}
                      </StatusBadge>
                    </td>
                    <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                      {h.status === "online" ? (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            onClick={async () => {
                              const id = await openSession(h, "ssh");
                              if (id) router.push(`/sessions/${id}`);
                            }}
                          >
                            <Terminal size={13} /> SSH
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const id = await openSession(h, "rdp");
                              if (id) router.push(`/sessions/${id}`);
                            }}
                          >
                            <Monitor size={13} /> Screen
                          </Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="subtle" disabled>
                          Offline
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="mt-4 flex items-center gap-2 text-xs text-ink-secondary/60">
        <Monitor size={13} /> Click any row to inspect host detail, live
        sessions, and history.
      </p>

      <RegisterHostModal
        open={registerOpen}
        live={mode === "live"}
        onClose={() => setRegisterOpen(false)}
        onSubmit={(host) => {
          addHost(host);
          setRegisterOpen(false);
        }}
        onError={(message) => toast("error", message)}
      />

      {selectedLive && (
        <HostDetailDrawer
          host={selectedLive}
          now={now}
          onClose={() => setSelected(null)}
          onDelete={(id) => {
            removeHost(id);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function EnvTag({ env }: { env: Environment }) {
  const tone =
    env === "prod"
      ? "border-danger/30 text-danger/90"
      : env === "staging"
        ? "border-warning/30 text-warning/90"
        : "border-border text-ink-secondary";
  return (
    <span className={clsx("rounded border px-1.5 py-0.5 font-mono text-[11px]", tone)}>
      {env}
    </span>
  );
}

function RegisterHostModal({
  open,
  live,
  onClose,
  onSubmit,
  onError,
}: {
  open: boolean;
  live: boolean;
  onClose: () => void;
  onSubmit: (host: Host) => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState({
    hostname: "",
    ipAddress: "",
    os: "linux" as OS,
    environment: "dev" as Environment,
    agentId: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!form.hostname.trim() || !form.ipAddress.trim() || !form.agentId.trim()) {
      setError("All fields are required.");
      return;
    }
    if (live) {
      setBusy(true);
      try {
        const host = await api.registerHost(form);
        onSubmit(host);
      } catch {
        onError("Registration failed — is the backend running?");
      } finally {
        setBusy(false);
      }
      return;
    }
    onSubmit({
      id: `h_${Date.now().toString(36)}`,
      status: "offline",
      lastSeen: new Date().toISOString(),
      registeredAt: new Date().toISOString(),
      ...form,
    });
    setForm({ hostname: "", ipAddress: "", os: "linux", environment: "dev", agentId: "" });
  }

  return (
    <Modal open={open} onClose={onClose} title="Register Host">
      <div className="space-y-4">
        <Field label="Hostname">
          <input
            className="input-dark"
            placeholder="web-server-03"
            value={form.hostname}
            onChange={(e) => setForm({ ...form, hostname: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="IP Address">
            <input
              className="input-dark font-mono"
              placeholder="10.0.0.20"
              value={form.ipAddress}
              onChange={(e) => setForm({ ...form, ipAddress: e.target.value })}
            />
          </Field>
          <Field label="Agent ID">
            <input
              className="input-dark font-mono"
              placeholder="agt_……"
              value={form.agentId}
              onChange={(e) => setForm({ ...form, agentId: e.target.value })}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="OS Type">
            <select
              className="input-dark"
              value={form.os}
              onChange={(e) => setForm({ ...form, os: e.target.value as OS })}
            >
              <option value="linux">Linux</option>
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
            </select>
          </Field>
          <Field label="Environment">
            <select
              className="input-dark"
              value={form.environment}
              onChange={(e) =>
                setForm({ ...form, environment: e.target.value as Environment })
              }
            >
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="prod">prod</option>
            </select>
          </Field>
        </div>
        {error && (
          <p className="rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <p className="text-xs text-ink-secondary/70">
          The agent must already be running on the target machine.
        </p>
        <div className="flex justify-end gap-2.5 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Registering…" : "Register"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
