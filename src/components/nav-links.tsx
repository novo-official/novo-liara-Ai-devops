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
    <nav aria-label="ناوبری اصلی" className="flex items-center gap-1">
      {items.map(({ href, label, icon: Icon }) => {
        const active = path === href || path.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm transition-colors hover:bg-muted",
              active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
