import { describe, expect, it } from "vitest";
import { cpu, crashLoop, database, http500, insufficient, memory, missingConfig, release } from "@/server/diagnostics/detectors";
import type { Detector, Semantics } from "@/server/diagnostics/types";
import { ev, NOW, pts, RUN, type Spec } from "../helpers/evidence-builder";

const run = (d: Detector, spec: Spec, semantics: Semantics = {}) => d.run({ runId: RUN, now: NOW, intent: "why_restarting", evidence: ev(spec), semantics });
const keys = (r: ReturnType<typeof run>) => r.findings.map((f) => f.hypothesis);
const only = (r: ReturnType<typeof run>) => r.findings[0]!;

// ---------------------------------------------------------------------------------------------------- A. crash loop
describe("A. crash loop", () => {
  const cycle = (ago: number) => [{ ago, msg: "Applet exited with code 1" }, { ago: ago - 10, msg: "Applet restarted" }];
  const exitLine = (ago: number) => ({ ago, msg: "process exited with code 1" });

  it("detects a loop from ≥3 timestamped restart cycles (events + logs → strong)", () => {
    const r = run(crashLoop, { events: [900, 650, 400, 150].flatMap(cycle), logs: [900, 650, 400, 150].map(exitLine) });
    expect(keys(r)).toEqual(["crash_loop"]);
    expect(only(r)).toMatchObject({ strength: "strong", kind: "observation", data: { cycles: 4, eventCycles: 4, logCycles: 4 } });
    expect(only(r).times).toHaveLength(4);
    expect(only(r).evidenceIds.sort()).toEqual([`${RUN}/events`, `${RUN}/logs`]);
  });

  it("one event pair (exited + restarted seconds apart) is ONE cycle, not two", () => {
    const r = run(crashLoop, { events: [...cycle(900), ...cycle(600)] });
    expect(keys(r)).toEqual(["isolated_restart"]);
    expect(only(r).data.cycles).toBe(2);
  });

  it("a single restart is NEVER classified as a loop", () => {
    for (const events of [cycle(300), [{ ago: 300, msg: "Applet restarted" }]]) {
      const r = run(crashLoop, { events });
      expect(keys(r)).toEqual(["isolated_restart"]);
      expect(only(r)).toMatchObject({ strength: "weak", limitations: ["single_restart_not_a_loop"] });
    }
  });

  it("single-source evidence is only moderate; a restarting runtime corroborates it", () => {
    const events = [900, 600, 300].flatMap(cycle);
    expect(only(run(crashLoop, { events })).strength).toBe("moderate");
    const withRuntime = run(crashLoop, { events, applets: [{ state: "restarting", reason: "process exited with code 1" }] });
    expect(only(withRuntime).strength).toBe("strong");
    expect(only(withRuntime).evidenceIds).toContain(`${RUN}/runtime`);
  });

  it("a 'restarting' runtime state WITHOUT timestamped evidence is not a loop", () => {
    const r = run(crashLoop, { applets: [{ state: "restarting" }], events: [{ ago: 100, msg: "Release deployed" }] });
    expect(r.findings).toEqual([]);
    expect(r.limitations).toContain("runtime_restarting_without_timestamps");
  });

  it("does not count non-failure events (deployed / started / scaled)", () => {
    const r = run(crashLoop, { events: [900, 600, 300, 100].map((ago) => ({ ago, msg: "Release v2 deployed / Applet started" })) });
    expect(r.findings).toEqual([]);
  });

  it("reports missing timeline evidence instead of guessing", () => {
    const r = run(crashLoop, { availability: { events: "access_denied", logs: "collection_failed" } });
    expect(r.findings).toEqual([]);
    expect(r.limitations).toContain("no_timeline_evidence");
  });

  it("works from exit lines in logs alone (events unavailable)", () => {
    const r = run(crashLoop, { availability: { events: "unsupported" }, logs: [800, 500, 200].map(exitLine) });
    expect(keys(r)).toEqual(["crash_loop"]);
    expect(only(r)).toMatchObject({ strength: "moderate", data: { logCycles: 3, eventCycles: 0 } });
  });
});

// ---------------------------------------------------------------------------------------------------- B. database
describe("B. database connection failures (categories are separate)", () => {
  const ctxRefused = "psycopg2.OperationalError: could not connect to server: Connection refused (postgres)";
  const cases: [string, string, string][] = [
    ["db_connection_refused", "refused", ctxRefused],
    ["db_connection_refused", "refused", "Error: connect ECONNREFUSED 10.0.0.4:5432"],
    ["db_connection_timeout", "timeout", "MongoServerSelectionError: connection timed out connecting to mongodb"],
    ["db_connection_timeout", "timeout", "Error: connect ETIMEDOUT 10.0.0.4:3306 (mysql)"],
    ["db_dns_failure", "dns", "getaddrinfo ENOTFOUND db.internal (postgres)"],
    ["db_dns_failure", "dns", "psycopg2.OperationalError: could not translate host name \"db\" to address (postgres)"],
    ["db_authentication_failure", "auth", 'FATAL: password authentication failed for user "app"'],
    ["db_authentication_failure", "auth", "Access denied for user 'app'@'10.0.0.9' (using password: YES)"],
    ["db_authentication_failure", "auth", "ReplyError: WRONGPASS invalid username-password pair (redis)"],
  ];
  it.each(cases)("classifies as %s: %s", (hyp, category, msg) => {
    const r = run(database, { logs: [{ ago: 100, msg }] });
    expect(keys(r)).toEqual([hyp]);
    expect(only(r).data.category).toBe(category);
  });

  it("keeps the four categories as separate findings", () => {
    const r = run(database, { logs: [{ ago: 10, msg: ctxRefused }, { ago: 20, msg: "getaddrinfo ENOTFOUND db (postgres)" }, { ago: 30, msg: "connect ETIMEDOUT (mysql)" }, { ago: 40, msg: 'password authentication failed for user "a"' }] });
    expect(keys(r).sort()).toEqual(["db_authentication_failure", "db_connection_refused", "db_connection_timeout", "db_dns_failure"]);
  });

  it("does not treat generic network errors without database context as database evidence", () => {
    const r = run(database, { logs: [{ ago: 5, msg: "Error: connect ECONNREFUSED 127.0.0.1:8080" }, { ago: 6, msg: "getaddrinfo ENOTFOUND api.stripe.com" }, { ago: 7, msg: "request timeout expired after 30s" }, { ago: 8, msg: "authentication failed for webhook signature" }] });
    expect(r.findings).toEqual([]);
  });

  it("strength follows the number of explicit lines (1 weak, 2 moderate, ≥3 strong)", () => {
    const n = (k: number) => only(run(database, { logs: Array.from({ length: k }, (_, i) => ({ ago: 100 + i, msg: ctxRefused })) })).strength;
    expect([n(1), n(2), n(3), n(8)]).toEqual(["weak", "moderate", "strong", "strong"]);
  });

  it("never exposes credentials or private hosts in excerpts", () => {
    const r = run(database, { logs: [{ ago: 5, msg: "could not connect to postgres://app:S3cretPass99@db.internal:5432/shop: Connection refused 10.1.2.3" }] });
    const text = JSON.stringify(only(r));
    expect(text).not.toMatch(/S3cretPass99|db\.internal|10\.1\.2\.3/);
    expect(only(r).excerpts[0]).toMatch(/\[REDACTED\]@host-1/);
  });

  it("also reads events and flags truncated logs as a lower bound", () => {
    const r = run(database, { events: [{ ago: 10, msg: "Applet failed: connect ETIMEDOUT (postgres)" }], logs: [{ ago: 5, msg: "ok" }], truncated: true });
    expect(keys(r)).toEqual(["db_connection_timeout"]);
    expect(r.limitations).toContain("logs_truncated");
  });
});

// ---------------------------------------------------------------------------------------------------- C. missing configuration
describe("C. missing configuration", () => {
  const msg = (m: string) => ({ logs: [{ ago: 30, msg: m }] });

  it("extracts variable NAMES only and confirms absence against the configured keys → strong", () => {
    const r = run(missingConfig, { ...msg("KeyError: 'DATABASE_URL'"), envKeys: ["NODE_ENV", "PORT"] });
    expect(only(r)).toMatchObject({ hypothesis: "missing_configuration", strength: "strong", data: { names: ["DATABASE_URL"], absent: ["DATABASE_URL"], presentButFailing: [] } });
    expect(only(r).evidenceIds).toContain(`${RUN}/app`);
  });

  it.each([
    ["KeyError: 'STRIPE_SECRET_KEY'", "STRIPE_SECRET_KEY"],
    ["TypeError: process.env.REDIS_URL is undefined", "REDIS_URL"],
    ["Error: Missing required environment variable: JWT_SECRET", "JWT_SECRET"],
    ["Environment variable API_BASE is required", "API_BASE"],
    ["django.core.exceptions.ImproperlyConfigured: The SECRET_KEY setting must not be empty.", "SECRET_KEY"],
    ["SMTP_HOST is not set", "SMTP_HOST"],
  ])("recognises %j", (m, name) => {
    expect(only(run(missingConfig, { ...msg(m), envKeys: [] })).data.names).toEqual([name]);
  });

  it("a key that EXISTS but still fails is reported as unverifiable (values are never read) → moderate", () => {
    const r = run(missingConfig, { ...msg("KeyError: 'DATABASE_URL'"), envKeys: ["DATABASE_URL"] });
    expect(only(r)).toMatchObject({ strength: "moderate", data: { presentButFailing: ["DATABASE_URL"], absent: [] } });
    expect(only(r).limitations).toContain("env_key_present_value_unverifiable");
  });

  it("without the env key list it cannot confirm absence", () => {
    const r = run(missingConfig, { ...msg("KeyError: 'DATABASE_URL'"), availability: { app: "access_denied" } });
    expect(only(r).strength).toBe("moderate");
    expect(r.limitations).toContain("env_keys_unavailable");
  });

  it("a vague configuration error without a name is only weak", () => {
    const r = run(missingConfig, msg("ImproperlyConfigured: configuration error"));
    expect(only(r)).toMatchObject({ strength: "weak", data: { names: [], genericOnly: true } });
  });

  it("ignores lowercase / non-variable keys and unrelated errors", () => {
    expect(run(missingConfig, msg("KeyError: 'user_id'")).findings).toEqual([]);
    expect(run(missingConfig, msg("TypeError: x is not a function")).findings).toEqual([]);
  });

  it("never contains ANY text from the log line (no excerpts: redaction is heuristic, names are enough)", () => {
    const r = run(missingConfig, msg("KeyError: 'API_KEY' while value=hunter2hunter2 password=abc12345xyz bare-secret-9f8e7d"));
    expect(only(r).excerpts).toEqual([]);
    expect(JSON.stringify(only(r))).not.toMatch(/hunter2|abc12345xyz|bare-secret/);
  });
});

// ---------------------------------------------------------------------------------------------------- D. memory
describe("D. memory pressure", () => {
  const grow = (n = 30, from = 100, step = 3) => ({ points: pts(n, 60, (i) => from + i * step) });

  it("explicit OOM in events → strong observation", () => {
    const r = run(memory, { events: [{ ago: 100, msg: "Applet OOMKilled (exit code 137)" }] });
    expect(only(r)).toMatchObject({ hypothesis: "oom_kill", kind: "observation", strength: "strong", data: { via: "explicit_oom_signal" } });
  });

  it("explicit OOM in an applet reason or log line is also found", () => {
    expect(keys(run(memory, { applets: [{ state: "restarting", reason: "OOMKilled" }] }))).toEqual(["oom_kill"]);
    expect(keys(run(memory, { logs: [{ ago: 5, msg: "Out of memory: Killed process 4242 (python)" }] }))).toEqual(["oom_kill"]);
  });

  it("exit code 137 alone is only a moderate INFERENCE (not proof of OOM)", () => {
    const r = run(memory, { logs: [{ ago: 5, msg: "worker exited with code 137" }] });
    expect(only(r)).toMatchObject({ hypothesis: "oom_kill", kind: "inference", strength: "moderate", data: { via: "exit_code_137" } });
    expect(only(r).limitations).toContain("exit137_not_proof_of_oom");
  });

  it("in-process heap exhaustion is a different hypothesis from a container OOM", () => {
    const r = run(memory, { logs: [{ ago: 5, msg: "FATAL ERROR: JavaScript heap out of memory" }] });
    expect(keys(r)).toEqual(["memory_exhaustion_in_process"]);
    expect(only(r).limitations).toContain("process_heap_limit_not_container_limit");
  });

  it("UNKNOWN units: raw growth is a weak observation and NEVER memory exhaustion", () => {
    const r = run(memory, { memory: grow() });
    expect(keys(r)).toEqual(["memory_growth_unverified"]);
    expect(only(r)).toMatchObject({ strength: "weak", kind: "observation" });
    expect(r.limitations).toContain("memory_units_unverified");
    expect(keys(r)).not.toContain("memory_pressure");
    expect(keys(r)).not.toContain("oom_kill");
  });

  it("huge raw values with unknown units still prove nothing", () => {
    const r = run(memory, { memory: { points: pts(30, 60, () => 9_999_999_999) } });
    expect(r.findings).toEqual([]); // flat: no growth either
    expect(r.limitations).toContain("memory_units_unverified");
  });

  it("needs ≥10 points and a (mostly) monotonic trend before even reporting growth", () => {
    expect(run(memory, { memory: grow(6) }).findings).toEqual([]);
    expect(run(memory, { memory: { points: pts(30, 60, (i) => 100 + (i % 2 ? 80 : 0)) } }).findings).toEqual([]);
    expect(run(memory, { memory: { points: pts(30, 60, (i) => 100 + i * 0.5) } }).findings).toEqual([]); // growth < 1.5x
  });

  it("with VERIFIED unit and a known limit, sustained ≥90% is memory_pressure (moderate)", () => {
    const sem: Semantics = { memory: { unit: "MiB", limit: 256, origin: "verified" } };
    const r = run(memory, { memory: { points: pts(10, 60, () => 240) } }, sem);
    expect(only(r)).toMatchObject({ hypothesis: "memory_pressure", strength: "moderate", data: { unit: "MiB", limit: 256 } });
    expect(only(r).limitations).toEqual([]);
    expect(run(memory, { memory: { points: pts(10, 60, () => 100) } }, sem).findings).toEqual([]);
    expect(run(memory, { memory: { points: pts(10, 60, (i) => (i === 9 ? 100 : 240)) } }, sem).findings).toEqual([]); // not sustained
  });

  it("simulated semantics are labelled; a unit without a limit cannot support pressure", () => {
    const sim = run(memory, { memory: { points: pts(10, 60, () => 250) } }, { memory: { unit: "MiB", limit: 256, origin: "simulated_fixture" } });
    expect(only(sim).limitations).toContain("simulated_semantics");
    const noLimit = run(memory, { memory: { points: pts(10, 60, () => 250) } }, { memory: { unit: "MiB", origin: "verified" } });
    expect(noLimit.findings).toEqual([]);
    expect(noLimit.limitations).toContain("memory_limit_unknown");
  });

  it("stale or missing metrics are not used", () => {
    expect(run(memory, { memory: grow(), availability: { memory: "stale" } }).limitations).toContain("memory_metrics_stale");
    expect(run(memory, { memory: grow(), availability: { memory: "stale" } }).findings).toEqual([]);
    expect(run(memory, {}).limitations).toContain("memory_metrics_missing");
    expect(run(memory, { availability: { memory: "access_denied" } }).limitations).toContain("memory_metrics_access_denied");
  });
});

// ---------------------------------------------------------------------------------------------------- E. cpu
describe("E. CPU saturation", () => {
  const sem: Semantics = { cpu: { unit: "cores", limit: 1, origin: "verified" } };
  const hot = (v = 0.97) => ({ cpu: { points: pts(10, 60, () => v) } });

  it("never infers anything from raw values with unknown units", () => {
    const r = run(cpu, hot(99_999));
    expect(r.findings).toEqual([]);
    expect(r.limitations).toEqual(["cpu_units_unverified"]);
  });

  it("a verified unit without a known limit is still not enough", () => {
    const r = run(cpu, hot(), { cpu: { unit: "cores", origin: "verified" } });
    expect(r.findings).toEqual([]);
    expect(r.limitations).toEqual(["cpu_limit_unknown"]);
  });

  it("verified unit + limit + sustained ≥90% → moderate inference (utilisation is not latency)", () => {
    const r = run(cpu, hot(), sem);
    expect(only(r)).toMatchObject({ hypothesis: "cpu_saturation", kind: "inference", strength: "moderate", data: { unit: "cores", limit: 1 } });
    expect(only(r).limitations).toContain("utilisation_not_latency");
  });

  it("requires sustained saturation and ratios relative to the limit", () => {
    expect(run(cpu, hot(0.5), sem).findings).toEqual([]);
    expect(run(cpu, { cpu: { points: pts(10, 60, (i) => (i === 9 ? 0.2 : 0.97)) } }, sem).findings).toEqual([]);
    expect(run(cpu, hot(300), { cpu: { unit: "millicores", limit: 1000, origin: "verified" } }).findings).toEqual([]);
    expect(only(run(cpu, hot(960), { cpu: { unit: "millicores", limit: 1000, origin: "verified" } })).data.ratioLast).toBe(0.96);
  });

  it("stale / missing / unsupported metrics yield limitations only", () => {
    expect(run(cpu, { ...hot(), availability: { cpu: "stale" } }, sem)).toMatchObject({ findings: [], limitations: ["cpu_metrics_stale"] });
    expect(run(cpu, {}, sem).limitations).toEqual(["cpu_metrics_missing"]);
    expect(run(cpu, { availability: { cpu: "contract_mismatch" } }, sem).limitations).toEqual(["cpu_metrics_contract_mismatch"]);
    expect(run(cpu, { omit: ["cpu"] }, sem)).toEqual({ findings: [], limitations: [] });
  });
});

// ---------------------------------------------------------------------------------------------------- F. release
describe("F. release regression / failed release", () => {
  const err = (ago: number) => ({ ago, msg: "ERROR unhandled exception in handler" });
  const burst = (from: number, n: number) => Array.from({ length: n }, (_, i) => err(from - i * 20));

  it("temporal correlation: a clean baseline, then an error burst after the release → moderate (never strong)", () => {
    const r = run(release, { releases: [{ tag: "v2", state: "READY", createdAgo: 1260, finishedAgo: 1200 }, { tag: "v1", state: "READY", createdAgo: 90000 }], logs: [{ ago: 3000, msg: "ok" }, ...burst(1100, 12)] });
    const f = r.findings.find((x) => x.hypothesis === "release_regression")!;
    expect(f).toMatchObject({ kind: "inference", strength: "moderate" });
    expect(f.limitations).toContain("correlation_not_causation");
    expect(f.data).toMatchObject({ releaseTag: "v2", errorsBefore: 0, errorsAfter: 12 });
  });

  it("without a pre-release baseline the correlation is only weak and says so", () => {
    const r = run(release, { releases: [{ tag: "v2", state: "READY", createdAgo: 3500, finishedAgo: 3480 }], logs: burst(3000, 10) });
    const f = r.findings.find((x) => x.hypothesis === "release_regression")!;
    expect(f.strength).toBe("weak");
    expect(f.limitations).toContain("no_pre_release_baseline");
  });

  it("no finding when errors were already happening before the release at a similar rate", () => {
    const r = run(release, { releases: [{ tag: "v2", state: "READY", createdAgo: 1800, finishedAgo: 1700 }], logs: [...burst(3400, 30), ...burst(1500, 6)] });
    expect(r.findings.find((x) => x.hypothesis === "release_regression")).toBeUndefined();
  });

  it("a release outside the examined window cannot be correlated", () => {
    const r = run(release, { releases: [{ tag: "v2", state: "READY", createdAgo: 11000, finishedAgo: 10900 }], logs: burst(500, 20) });
    expect(r.findings).toEqual([]);
    expect(r.limitations).toContain("release_outside_window");
  });

  it("too few errors after the release is not a regression", () => {
    const r = run(release, { releases: [{ tag: "v2", state: "READY", createdAgo: 1800, finishedAgo: 1700 }], logs: [{ ago: 3000, msg: "ok" }, ...burst(900, 3)] });
    expect(r.findings).toEqual([]);
  });

  it("failed recent release that never became current: moderate and explicit about it", () => {
    const r = run(release, { releases: [{ tag: "v7", state: "FAILED", createdAgo: 1800, finishedAgo: 1700 }, { tag: "v6", state: "READY", createdAgo: 345600 }], currentRelease: "v6" });
    expect(only(r)).toMatchObject({ hypothesis: "release_failed", strength: "moderate", data: { latestTag: "v7", failedIsCurrent: false } });
    expect(only(r).limitations).toEqual(expect.arrayContaining(["failed_release_is_not_current", "release_state_vocabulary_unverified"]));
  });

  it("a failed release already superseded by a newer successful one is only weak history", () => {
    const r = run(release, { releases: [{ tag: "v5", state: "READY", createdAgo: 3600 }, { tag: "v4", state: "FAILED", createdAgo: 90000 }] });
    expect(only(r)).toMatchObject({ hypothesis: "release_failed", strength: "weak" });
  });

  it("old failures (>72h) are ignored; no history is reported as a limitation", () => {
    expect(run(release, { releases: [{ tag: "v1", state: "FAILED", createdAgo: 400000 }] }).findings).toEqual([]);
    expect(run(release, { releases: [] }).limitations).toContain("no_release_history");
  });

  it("without any logs or events there is nothing to correlate", () => {
    expect(run(release, { releases: [{ tag: "v2", state: "READY", createdAgo: 1800 }] }).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------- G. HTTP 500
describe("G. HTTP 500 evidence", () => {
  const access = (code: number, ago = 10, path = "/checkout") => ({ ago, msg: `10.0.0.5 - - "GET ${path} HTTP/1.1" ${code} 87` });

  it("counts explicit 500 lines; never computes a rate", () => {
    const r = run(http500, { logs: [access(500, 10), access(500, 20), access(200, 30), access(500, 40)] });
    expect(only(r)).toMatchObject({ hypothesis: "http_500", strength: "strong", data: { count500: 3, sampledLines: 4 } });
    expect(Object.keys(only(r).data).join(",")).not.toMatch(/rate|percent|ratio/i);
    expect(r.limitations).toEqual(expect.arrayContaining(["no_http_error_rate", "no_http_probe"]));
  });

  it("recognises framework-style 500 messages", () => {
    for (const msg of ["Internal Server Error", "statusCode: 500, message: Cannot read", "POST /api/order -> 500 Internal Server Error", "request failed status=500"]) {
      expect(keys(run(http500, { logs: [{ ago: 5, msg }] })), msg).toEqual(["http_500"]);
    }
  });

  it("does not mistake other numbers for HTTP 500", () => {
    const logs = ["response time 500ms", "listening on port 5000", "processed 500 rows", "GET /items?limit=500 200", "build 5001 done", "retry in 500 ms"].map((msg, i) => ({ ago: 5 + i, msg }));
    expect(run(http500, { logs }).findings).toEqual([]);
  });

  it("other 5xx are counted separately and are not 'HTTP 500'", () => {
    const r = run(http500, { logs: [access(502), access(503)] });
    expect(r.findings).toEqual([]);
    const mixed = run(http500, { logs: [access(502), access(500)] });
    expect(only(mixed).data).toMatchObject({ count500: 1, otherServerErrors: 1, });
    expect(only(mixed).strength).toBe("weak");
  });

  it("flags truncated logs (counts are lower bounds) and tolerates missing logs", () => {
    expect(run(http500, { logs: [access(500)], truncated: true }).limitations).toContain("logs_truncated");
    expect(run(http500, {})).toEqual({ findings: [], limitations: [] });
  });
});

// ---------------------------------------------------------------------------------------------------- H. insufficient evidence
describe("H. insufficient evidence", () => {
  it("states why when no timeline (logs/events) is usable, citing the unusable sources", () => {
    const r = run(insufficient, {});
    expect(only(r)).toMatchObject({ hypothesis: "insufficient_evidence", data: { reasons: expect.arrayContaining(["logs:missing", "events:missing"]) } });
    expect(only(r).evidenceIds.sort()).toEqual([`${RUN}/events`, `${RUN}/logs`]);
    expect(r.limitations).toEqual(expect.arrayContaining(["src_logs_missing", "src_events_missing"]));
  });

  it("distinguishes WHY each source is unusable", () => {
    const r = run(insufficient, { availability: { logs: "access_denied", events: "contract_mismatch", cpu: "stale" } });
    expect(only(r).data.reasons).toEqual(expect.arrayContaining(["logs:access_denied", "events:contract_mismatch"]));
    expect(r.limitations).toEqual(expect.arrayContaining(["src_logs_access_denied", "src_events_contract_mismatch", "src_cpu_stale"]));
  });

  it("is NOT raised when a timeline exists, but partial gaps are still recorded", () => {
    const r = run(insufficient, { logs: [{ ago: 5, msg: "hello" }], availability: { memory: "collection_failed" } });
    expect(r.findings).toEqual([]);
    expect(r.limitations).toContain("src_memory_collection_failed");
  });
});
