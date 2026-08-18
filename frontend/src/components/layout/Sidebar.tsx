"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import {
  Activity,
  ChevronsLeft,
  ChevronsRight,
  LayoutDashboard,
  Monitor,
  ScrollText,
  Settings,
  Shield,
  UserRound,
} from "lucide-react";
import { useApp } from "@/lib/app-store";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/hosts", label: "Hosts", icon: Monitor },
  { href: "/sessions", label: "Sessions", icon: Activity },
  { href: "/audit", label: "Audit", icon: ScrollText },
];

const FOOTER_NAV = [
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/profile", label: "Profile", icon: UserRound },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const { sessions, mode } = useApp();

  const activeCount = sessions.filter((s) => s.status === "active").length;

  const modeChip =
    mode === "live"
      ? { label: "LIVE", cls: "text-success border-success/40 bg-success/10" }
      : mode === "offline"
        ? { label: "OFFLINE", cls: "text-danger border-danger/40 bg-danger/10" }
        : { label: "···", cls: "text-ink-secondary border-border" };

  function Item({
    href,
    label,
    icon: Icon,
    badge,
  }: {
    href: string;
    label: string;
    icon: typeof Activity;
    badge?: number;
  }) {
    const active = pathname.startsWith(href);
    return (
      <Link
        href={href}
        title={collapsed ? label : undefined}
        className={clsx(
          "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors duration-150",
          active
            ? "bg-accent/[0.08] text-ink-primary"
            : "text-ink-secondary hover:bg-white/[0.03] hover:text-ink-primary",
        )}
      >
        {active && (
          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-accent shadow-[0_0_8px_rgba(14,165,233,0.7)]" />
        )}
        <Icon size={18} className="shrink-0" />
        {!collapsed && (
          <>
            <span className="flex-1 font-medium">{label}</span>
            {!!badge && (
              <span className="rounded-full bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent">
                {badge}
              </span>
            )}
          </>
        )}
      </Link>
    );
  }

  return (
    <aside
      className={clsx(
        "sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-ocean transition-[width] duration-200",
        collapsed ? "w-[64px]" : "w-56",
      )}
    >
      <div className="flex h-16 items-center gap-2.5 border-b border-border px-4">
        <Shield size={20} className="text-accent" />
        {!collapsed ? (
          <>
            <span className="font-mono text-[15px] font-bold tracking-tight">
              PAM<span className="text-accent">.</span>
            </span>
            <span
              className={`ml-auto rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-widest ${modeChip.cls}`}
              title={
                mode === "live"
                  ? "Connected to backend"
                  : mode === "offline"
                    ? "Backend unreachable — retrying"
                    : "Connecting…"
              }
            >
              {modeChip.label}
            </span>
          </>
        ) : null}
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {NAV.map((n) => (
          <Item key={n.href} {...n} badge={n.href === "/sessions" ? activeCount : undefined} />
        ))}
        <div className="my-3 h-px bg-border" />
        {FOOTER_NAV.map((n) => (
          <Item key={n.href} {...n} />
        ))}
      </nav>

      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-3 border-t border-border px-3 py-3 text-sm text-ink-secondary transition-colors hover:text-ink-primary"
      >
        {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
        {!collapsed && <span>Collapse</span>}
      </button>
    </aside>
  );
}
