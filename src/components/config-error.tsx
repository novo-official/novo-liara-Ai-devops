import { TriangleAlert } from "lucide-react";

/** Shown when configuration is invalid. Problems contain variable names only (never values). */
export function ConfigErrorView({ problems }: { problems: string[] }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl items-center px-4 py-10">
      <div role="alert" className="w-full rounded-xl border border-destructive/40 bg-destructive/10 p-5">
        <h1 className="mb-3 flex items-center gap-2 text-lg font-semibold text-destructive">
          <TriangleAlert aria-hidden /> پیکربندی نامعتبر است
        </h1>
        <p className="mb-3 text-sm text-muted-foreground">برنامه تا اصلاح تنظیمات محیطی (.env) به‌صورت امن متوقف شده است:</p>
        <ul className="ltr-isolate list-disc space-y-1 ps-5 text-sm">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
    </main>
  );
}
