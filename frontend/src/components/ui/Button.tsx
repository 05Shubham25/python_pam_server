"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import clsx from "clsx";

type Variant = "primary" | "danger" | "ghost" | "subtle";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
}

const VARIANT: Record<Variant, string> = {
  primary:
    "btn-shimmer bg-accent text-white hover:brightness-110 hover:shadow-[0_0_20px_rgba(14,165,233,0.35)]",
  danger:
    "btn-shimmer bg-danger text-white hover:brightness-110 hover:shadow-[0_0_20px_rgba(239,68,68,0.3)]",
  ghost:
    "border border-border bg-transparent text-ink-primary hover:border-accent/40 hover:bg-accent/10",
  subtle:
    "bg-raised text-ink-secondary hover:text-ink-primary hover:bg-border/40",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "primary", size = "md", className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2.5 text-sm",
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
});
