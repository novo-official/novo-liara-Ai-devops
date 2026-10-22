/** Persian number/date formatting. Explicit locale + time zone so server and client render identically. */
const TZ = "Asia/Tehran";

export function faNumber(n: number, opts: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat("fa-IR", opts).format(n);
}

export function faDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { dateStyle: "medium", timeStyle: "short", timeZone: TZ }).format(d);
}

export function faTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ, hour12: false }).format(d);
}

/** Compact number for chart axes (raw values, unit unknown). */
export function faCompact(n: number): string {
  return faNumber(n, { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 3 });
}

/** "۴ دقیقه پیش" style relative age (seconds in). Pure; callers supply the age. */
export function relativeFa(ageSec: number, fa: { s: (n: string) => string; m: (n: string) => string; h: (n: string) => string; d: (n: string) => string }): string {
  const a = Math.max(0, Math.round(ageSec));
  if (a < 60) return fa.s(faNumber(a));
  if (a < 3600) return fa.m(faNumber(Math.round(a / 60)));
  if (a < 86400) return fa.h(faNumber(Math.round(a / 3600)));
  return fa.d(faNumber(Math.round(a / 86400)));
}
