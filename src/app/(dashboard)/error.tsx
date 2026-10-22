"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fa } from "@/i18n/fa";

// Never render error.message: it could contain internal details.
export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl border border-destructive/40 bg-destructive/10 p-6 text-center">
      <TriangleAlert className="size-8 text-destructive" aria-hidden />
      <h1 className="text-lg font-semibold">{fa.state.errorTitle}</h1>
      <p className="text-sm text-muted-foreground">{fa.errors.internal}</p>
      <Button onClick={reset} className="min-h-11 px-4">
        {fa.state.retry}
      </Button>
    </div>
  );
}
