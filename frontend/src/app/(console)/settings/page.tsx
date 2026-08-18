"use client";

import { useState } from "react";
import clsx from "clsx";
import { KeyRound, Plug, Shield, SlidersHorizontal } from "lucide-react";
import { useApp } from "@/lib/app-store";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Modal";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "security", label: "Security", icon: Shield },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "danger", label: "Danger Zone", icon: KeyRound },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function SettingsPage() {
  const [section, setSection] = useState<SectionId>("general");
  const { toast } = useApp();

  return (
    <div className="animate-fade-up">
      <PageHeader title="Settings" subtitle="Control plane configuration." />

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav className="flex h-fit gap-1 overflow-x-auto lg:flex-col">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setSection(id)}
              className={clsx(
                "flex shrink-0 items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors",
                id === "danger" && section !== id
                  ? "text-danger/70 hover:bg-danger/5 hover:text-danger"
                  : section === id
                    ? id === "danger"
                      ? "bg-danger/10 text-danger"
                      : "bg-raised text-ink-primary"
                    : "text-ink-secondary hover:bg-white/[0.03] hover:text-ink-primary",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        <div className="space-y-6">
          {section === "general" && (
            <Card className="p-6">
              <h3 className="mb-5 text-sm font-semibold">General</h3>
              <div className="max-w-md space-y-4">
                <Field label="Application name">
                  <input className="input-dark" defaultValue="PAM Control Plane" />
                </Field>
                <Field label="Timezone">
                  <select className="input-dark" defaultValue="utc">
                    <option value="utc">UTC</option>
                    <option value="ist">Asia/Kolkata</option>
                    <option value="est">America/New_York</option>
                  </select>
                </Field>
                <Button size="sm" onClick={() => toast("success", "Settings saved")}>
                  Save changes
                </Button>
              </div>
            </Card>
          )}

          {section === "security" && (
            <Card className="p-6">
              <h3 className="mb-5 text-sm font-semibold">Security</h3>
              <div className="max-w-md space-y-4">
                <Field label="JWT expiry (minutes)">
                  <input className="input-dark font-mono" defaultValue="60" />
                </Field>
                <Field label="Idle session timeout (minutes)">
                  <input className="input-dark font-mono" defaultValue="15" />
                </Field>
                <Field label="Max concurrent sessions per user">
                  <input className="input-dark font-mono" defaultValue="3" />
                </Field>
                <Button size="sm" onClick={() => toast("success", "Security policy updated")}>
                  Save changes
                </Button>
              </div>
            </Card>
          )}

          {section === "integrations" && (
            <div className="space-y-6">
              <Card className="p-6">
                <h3 className="mb-1 text-sm font-semibold">Vault</h3>
                <p className="mb-5 text-xs text-ink-secondary">
                  Credential broker for host secrets.
                </p>
                <div className="grid max-w-lg grid-cols-2 gap-4">
                  <Field label="Endpoint">
                    <input className="input-dark font-mono" defaultValue="https://vault.internal:8200" />
                  </Field>
                  <Field label="Auth method">
                    <select className="input-dark" defaultValue="approle">
                      <option value="approle">AppRole</option>
                      <option value="token">Token</option>
                    </select>
                  </Field>
                </div>
              </Card>
              <Card className="p-6">
                <h3 className="mb-1 text-sm font-semibold">SMTP</h3>
                <p className="mb-5 text-xs text-ink-secondary">
                  Notifications for approvals and alerts.
                </p>
                <div className="grid max-w-lg grid-cols-2 gap-4">
                  <Field label="Host">
                    <input className="input-dark font-mono" defaultValue="smtp.company.com" />
                  </Field>
                  <Field label="Port">
                    <input className="input-dark font-mono" defaultValue="587" />
                  </Field>
                </div>
              </Card>
              <Button size="sm" onClick={() => toast("success", "Integrations saved")}>
                Save integrations
              </Button>
            </div>
          )}

          {section === "danger" && (
            <Card className="border-danger/30 p-6">
              <h3 className="mb-1 text-sm font-semibold text-danger">Danger Zone</h3>
              <p className="mb-6 text-xs text-ink-secondary">
                Irreversible operations. Proceed carefully.
              </p>
              <div className="max-w-lg space-y-4">
                {[
                  ["Reset database", "Wipes hosts, sessions, and audit events. Requires re-registration of all agents."],
                  ["Purge recordings", "Deletes every stored session recording from object storage."],
                ].map(([title, desc]) => (
                  <div
                    key={title}
                    className="flex items-center justify-between gap-4 rounded-lg border border-danger/25 bg-danger/[0.04] px-4 py-3.5"
                  >
                    <div>
                      <p className="text-[13px] font-medium">{title}</p>
                      <p className="mt-0.5 text-xs text-ink-secondary">{desc}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => toast("error", "Blocked in demo mode")}
                    >
                      Execute
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
