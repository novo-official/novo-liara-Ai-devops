"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { faNumber } from "@/lib/format";

/** mm:ss until `expiresAt`. Cosmetic only: expiry is enforced by the server (clock skew can never extend an approval). */
export function Countdown({ expiresAt, onExpire }: { expiresAt: string; onExpire?: () => void }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    let fired = false;
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
      setLeft(s);
      if (s === 0 && !fired) {
        fired = true;
        onExpire?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, onExpire]);
  if (left === null) return null;
  const mm = faNumber(Math.floor(left / 60), { minimumIntegerDigits: 2 });
  const ss = faNumber(left % 60, { minimumIntegerDigits: 2 });
  return (
    <span data-testid="countdown" data-expired={left === 0 ? "true" : "false"} className="inline-flex items-center gap-1 tabular-nums">
      <Timer className="size-3.5" aria-hidden />
      {mm}:{ss}
    </span>
  );
}
