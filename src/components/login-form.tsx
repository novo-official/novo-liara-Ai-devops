"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fa } from "@/i18n/fa";

export function LoginForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: String(form.get("password") ?? "") }),
      });
      if (res.ok) {
        router.replace("/apps");
        router.refresh();
        return;
      }
      setError(res.status === 401 ? fa.login.invalid : res.status === 429 ? fa.login.tooMany : res.status === 503 ? fa.login.notConfigured : fa.login.generic);
    } catch {
      setError(fa.login.generic);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="text-sm font-medium">
          {fa.login.password}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={!configured || pending}
          dir="ltr"
          aria-describedby={error ? "login-error" : undefined}
          aria-invalid={error ? true : undefined}
          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-start text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
      </div>
      {!configured && (
        <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          {fa.login.notConfigured}
        </p>
      )}
      {error && (
        <p id="login-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={!configured || pending} className="h-11 text-base">
        {pending ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <LogIn aria-hidden />}
        {pending ? fa.login.submitting : fa.login.submit}
      </Button>
    </form>
  );
}
