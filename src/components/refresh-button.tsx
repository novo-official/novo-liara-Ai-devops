"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fa } from "@/i18n/fa";

/** Re-runs the server components (read-only GETs). */
export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="outline" className="min-h-11 px-3" disabled={pending} onClick={() => start(() => router.refresh())}>
      <RefreshCw className={pending ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden />
      {pending ? fa.detail.refreshing : fa.detail.refresh}
    </Button>
  );
}
