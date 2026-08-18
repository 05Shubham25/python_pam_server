"use client";

import { useApp } from "@/lib/app-store";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Modal";
import { Avatar } from "@/components/ui/Avatar";

export default function ProfilePage() {
  const { user, toast } = useApp();

  return (
    <div className="animate-fade-up">
      <PageHeader title="Profile" subtitle="Your account on this control plane." />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <div className="mb-6 flex items-center gap-4">
            <Avatar name={user.name} size={52} />
            <div>
              <p className="text-[15px] font-semibold">{user.name}</p>
              <p className="font-mono text-xs text-ink-secondary">{user.email}</p>
            </div>
            <span className="ml-auto rounded-full bg-accent/10 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide text-accent">
              {user.role}
            </span>
          </div>
          <div className="max-w-sm space-y-4">
            <Field label="Display name">
              <input className="input-dark" defaultValue={user.name} />
            </Field>
            <Field label="Email">
              <input className="input-dark font-mono" defaultValue={user.email} disabled />
            </Field>
            <p className="text-xs text-ink-secondary/70">
              Account details come from the server user registry.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
