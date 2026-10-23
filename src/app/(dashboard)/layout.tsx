import Link from "next/link";
import { Cloud } from "lucide-react";
import { ConfigErrorView } from "@/components/config-error";
import { LogoutButton } from "@/components/logout-button";
import { ModeBadge, ModeBanner } from "@/components/mode-badge";
import { NavLinks } from "@/components/nav-links";
import { ConfigError, getConfig } from "@/server/config/env";
import { requireSession } from "@/server/auth-dal";
import { fa } from "@/i18n/fa";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await requireSession();
  let mode: "mock" | "live";
  try {
    mode = getConfig().dataSource;
  } catch (e) {
    if (e instanceof ConfigError) return <ConfigErrorView problems={e.problems} />;
    throw e;
  }
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
        {fa.nav.skip}
      </a>
      <header className="sticky top-0 z-40 border-b border-border/50 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60 shadow-xs">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link href="/apps" className="group inline-flex min-h-10 items-center gap-2.5 font-bold tracking-tight text-foreground hover:opacity-95 transition-opacity">
              <span className="flex size-8 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 border border-primary/25 text-primary shadow-xs group-hover:scale-105 transition-transform">
                <Cloud className="size-4.5" aria-hidden />
              </span>
              <span className="text-base font-extrabold bg-gradient-to-l from-foreground via-foreground to-foreground/80 bg-clip-text">
                {fa.app.name}
              </span>
            </Link>
            <NavLinks />
          </div>
          <div className="flex items-center gap-2.5">
            <ModeBadge mode={mode} />
            <LogoutButton />
          </div>
        </div>
      </header>
      <ModeBanner mode={mode} />
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
