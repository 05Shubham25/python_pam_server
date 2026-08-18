"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { AppStoreProvider } from "@/lib/app-store";

export default function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined" && !localStorage.getItem("pam_user")) {
      router.replace("/login");
    }
  }, [router]);

  return (
    <AppStoreProvider>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 overflow-x-hidden">
          <div className="mx-auto max-w-[1400px] px-8 py-8">{children}</div>
        </main>
      </div>
    </AppStoreProvider>
  );
}
