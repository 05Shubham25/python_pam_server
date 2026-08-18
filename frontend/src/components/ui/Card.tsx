import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

export function Card({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx("rounded-xl border border-border bg-ocean", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  action,
}: {
  title: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
      <h3 className="text-sm font-semibold text-ink-primary">{title}</h3>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-14 text-center">
      <p className="text-sm font-medium text-ink-secondary">{title}</p>
      {hint && <p className="text-xs text-ink-secondary/60">{hint}</p>}
    </div>
  );
}
