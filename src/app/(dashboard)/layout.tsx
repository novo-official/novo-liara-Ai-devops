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
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link href="/apps" className="inline-flex min-h-11 items-center gap-2 font-semibold">
              <Cloud className="size-5 text-primary" aria-hidden />
              {fa.app.name}
            </Link>
            <NavLinks />
          </div>
          <div className="flex items-center gap-2">
            <ModeBadge mode={mode} />
            <LogoutButton />
          </div>
        </div>
      </header>
      <ModeBanner mode={mode} />
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
