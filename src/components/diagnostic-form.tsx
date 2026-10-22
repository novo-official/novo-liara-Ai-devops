"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage, fa } from "@/i18n/fa";
import { intentLabel } from "@/i18n/diagnostics-fa";
import { INTENTS, type Intent } from "@/server/diagnostics/types";

const a = fa.assistant;
const WINDOWS = ["15", "60", "360", "1440"];

export function DiagnosticForm({ apps }: { apps: string[] }) {
  const router = useRouter();
  const [app, setApp] = useState(apps[0] ?? "");
  const [intent, setIntent] = useState<Intent>(INTENTS[0]);
  const [win, setWin] = useState("60");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/diagnostic-runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app, intent, windowMinutes: Number(win) }) });
      const data = (await res.json()) as { run?: { id: string }; error?: { message?: string } };
      if (res.ok && data.run) {
        router.push(`/assistant/runs/${data.run.id}`);
        return;
      }
      const existing = res.headers.get("X-Existing-Run");
      if (existing) {
        router.push(`/assistant/runs/${existing}`);
        return;
      }
      setError(data.error?.message ?? errorMessage("internal"));
    } catch {
      setError(errorMessage("network"));
    } finally {
      setPending(false);
    }
  }

  if (apps.length === 0) return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{a.noApps}</p>;
  return (
    <form onSubmit={submit} className="flex flex-col gap-5" data-testid="diagnostic-form">
      <div className="flex flex-col gap-2">
        <label htmlFor="app" className="text-sm font-medium">
          {a.formApp}
        </label>
        <select id="app" value={app} onChange={(e) => setApp(e.target.value)} dir="ltr" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-start text-base">
          {apps.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{a.formIntent}</legend>
        {INTENTS.map((i) => (
          <label key={i} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
            <input type="radio" name="intent" value={i} checked={intent === i} onChange={() => setIntent(i)} className="size-4 accent-[var(--primary)]" />
            {intentLabel[i]}
          </label>
        ))}
        <p className="text-xs text-muted-foreground">{a.intentNote}</p>
      </fieldset>
      <div className="flex flex-col gap-2">
        <label htmlFor="window" className="text-sm font-medium">
          {a.formWindow}
        </label>
        <select id="window" value={win} onChange={(e) => setWin(e.target.value)} className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:max-w-xs">
          {WINDOWS.map((w) => (
            <option key={w} value={w}>
              {fa.detail.windows[w]}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending} className="h-11 text-base sm:w-fit" data-testid="start-run">
        {pending ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Play aria-hidden />}
        {pending ? a.starting : a.start}
      </Button>
    </form>
  );
}
