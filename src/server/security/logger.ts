import { redactDeep, redactText } from "./redact";

/** Structured logger. Every field is deep-redacted; raw upstream payloads must never be passed in. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let sink: (line: string) => void = (line) => process.stderr.write(line + "\n");

export function __setLogSinkForTests(fn: ((line: string) => void) | undefined): void {
  sink = fn ?? ((line) => process.stderr.write(line + "\n"));
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER.info) return;
  const entry = { ts: new Date().toISOString(), level, event: redactText(event, { maxLength: 100 }), ...redactDeep(fields) };
  try {
    sink(JSON.stringify(entry));
  } catch {
    sink(JSON.stringify({ ts: entry.ts, level, event: "log_serialization_failed" }));
  }
}
