import Link from "next/link";
import { SearchX } from "lucide-react";
import { fa } from "@/i18n/fa";

// Identical for unknown, malformed and non-allowlisted app names (no existence oracle).
export default function NotFound() {
  return (
    <div role="alert" data-testid="not-found" className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center">
      <SearchX className="size-8 text-muted-foreground" aria-hidden />
      <h1 className="text-lg font-semibold">{fa.state.notFoundTitle}</h1>
      <p className="text-sm text-muted-foreground">{fa.state.notFoundBody}</p>
      <Link href="/apps" className="inline-flex min-h-11 items-center rounded-lg border px-4 text-sm hover:bg-muted">
        {fa.detail.back}
      </Link>
    </div>
  );
}
