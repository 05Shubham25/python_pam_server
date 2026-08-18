"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Eye, EyeOff, Lock, ShieldCheck, Video, Zap, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";

const FEATURES = [
  { icon: Lock, label: "Encrypted Sessions" },
  { icon: Video, label: "Full Audit Trail" },
  { icon: Zap, label: "Real-time Access" },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("shubh@company.com");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      setError("Enter both email and password.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const user = await api.login(email, password);
      localStorage.setItem("pam_user", JSON.stringify(user));
      router.push("/dashboard");
      return;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("Invalid email or password.");
      } else {
        setError("Cannot reach the PAM server. Is the backend running?");
      }
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* Branding panel */}
      <div className="relative hidden w-[40%] flex-col justify-between overflow-hidden bg-gradient-to-br from-abyss via-[#081426] to-[#0B2040] p-12 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-40 h-[480px] w-[480px] rounded-full bg-accent/[0.05] blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-52 -left-32 h-[420px] w-[420px] rounded-full bg-accent/[0.04] blur-3xl"
        />

        <div className="flex items-center gap-2.5 font-mono text-[15px] font-bold tracking-tight">
          <ShieldCheck size={22} className="text-accent" />
          PAM<span className="text-accent">.</span>
        </div>

        <div className="relative">
          <h1 className="text-4xl font-bold leading-tight tracking-tight">
            Zero Trust.
            <br />
            Full Control.
          </h1>
          <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-ink-secondary">
            Every privileged session brokered, recorded, and verifiable. Your
            infrastructure, under watch.
          </p>
        </div>

        <div className="flex flex-wrap gap-2.5">
          {FEATURES.map(({ icon: Icon, label }) => (
            <span
              key={label}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-ocean/60 px-3.5 py-1.5 text-xs text-ink-secondary"
            >
              <Icon size={13} className="text-accent" />
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center bg-abyss p-6">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="w-full max-w-[420px]"
        >
          <div className="mb-8 flex items-center gap-2.5 font-mono text-[15px] font-bold tracking-tight lg:hidden">
            <ShieldCheck size={22} className="text-accent" />
            PAM<span className="text-accent">.</span>
          </div>

          <h2 className="text-2xl font-bold tracking-tight">Sign in to PAM</h2>
          <p className="mt-1.5 text-sm text-ink-secondary">
            Use your enterprise credentials to continue.
          </p>

          <form onSubmit={onSubmit} className="mt-8 space-y-5" noValidate>
            <label className="block">
              <span className="label-xs mb-1.5 block">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="you@company.com"
                className="input-dark"
              />
            </label>

            <label className="block">
              <span className="label-xs mb-1.5 block">Password</span>
              <div className="relative">
                <input
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="••••••••••"
                  className="input-dark pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-secondary/60 transition-colors hover:text-ink-primary"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>

            {error && (
              <p className="rounded-lg border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="btn-shimmer flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-3 text-sm font-semibold text-white transition-all duration-150 hover:brightness-110 hover:shadow-[0_0_24px_rgba(14,165,233,0.35)] disabled:opacity-60"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {busy ? "Authenticating…" : "Sign In"}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-ink-secondary/70">
            First sign-in creates the administrator account.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
