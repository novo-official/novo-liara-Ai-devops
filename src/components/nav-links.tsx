"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Bot, LayoutGrid, Stethoscope } from "lucide-react";
import { cn } from "@/lib/utils";
import { fa } from "@/i18n/fa";

const items = [
  { href: "/apps", label: fa.nav.apps, icon: LayoutGrid },
  { href: "/agent", label: fa.nav.agent, icon: Bot },
  { href: "/assistant", label: fa.nav.assistant, icon: Stethoscope },
  { href: "/diagnostics", label: fa.nav.diagnostics, icon: Activity },
] as const;

export function NavLinks() {
  const path = usePathname();
  return (
    <nav aria-label="ناوبری اصلی" className="flex items-center gap-1 rounded-xl bg-card/60 p-1 border border-border/60 shadow-inner backdrop-blur-md">
      {items.map(({ href, label, icon: Icon }) => {
        const active = path === href || path.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative inline-flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-xs sm:text-sm font-medium transition-all duration-200 select-none",
              active
                ? "bg-primary/15 text-primary border border-primary/25 shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
            )}
          >
            <Icon className={cn("size-4 transition-transform duration-200", active && "scale-110 text-primary")} aria-hidden />
            <span>{label}</span>
            {active && (
              <span className="absolute -bottom-1 start-1/2 -translate-x-1/2 w-4 h-[2px] rounded-full bg-primary" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

