import { describe, expect, it } from "vitest";
import { Secret } from "@/server/security/secret";
import { classifyStatus, CreateAppRequestSchema, CreateReleaseRequestSchema } from "@/server/live/contract";
import { financialFor, listCandidates, selectPlan } from "@/server/live/plans";
import { buildProbeHost, isBlockedAddress, safeProbe, type RequestFn } from "@/server/live/probe";
import { assess, classifyReleaseState, evaluateLadder, verdictOf, type Snapshot } from "@/server/live/verify";
import { LiaraWriteClient } from "@/server/live/write-client";
import { parsePlanUnits } from "@/server/live/units";
import { CANARY } from "../helpers/canaries";
import { CATALOGUE, UNITS } from "../helpers/live-exec";

describe("units & billing semantics are operator-verified, never guessed", () => {
  it("absent or invalid LIARA_PLAN_UNITS_JSON means NO units", () => {
    expect(parsePlanUnits(undefined).units).toBeNull();
    expect(parsePlanUnits("").units).toBeNull();
    expect(parsePlanUnits("{not json").problem).toMatch(/not valid JSON/);
    expect(parsePlanUnits(JSON.stringify({ ...UNITS, ram: "TB" })).problem).toMatch(/schema/);
    expect(parsePlanUnits(JSON.stringify({ ...UNITS, extra: 1 })).problem).toMatch(/schema/);
    expect(parsePlanUnits(JSON.stringify({ ...UNITS, source: "x" })).problem).toMatch(/schema/); // a source is mandatory
    expect(parsePlanUnits(JSON.stringify(UNITS)).units).toEqual(UNITS);
  });
});

describe("plan selection", () => {
  const sel = (planId: string, units = UNITS as typeof UNITS | null, extra: Partial<Parameters<typeof selectPlan>[0]> = {}) => selectPlan({ projection: CATALOGUE, planId, units, minRamMb: 512, ...extra });
  it("accepts an available plan with an unambiguous bundle plan and verified units", () => {
    const s = sel("g2-small");
    expect(s).toMatchObject({ ok: true, blockers: [], bundlePlanId: "bronze" });
    expect(s.plan?.id).toBe("g2-small");
    expect(s.financial.unitsVerified).toBe(true);
  });
  it("blocks unknown, unavailable and availability-unknown plans, and invalid ids", () => {
    expect(sel("nope").blockers).toContain("plan_not_found");
    expect(sel("g2-off").blockers).toContain("plan_unavailable");
    expect(sel("g2-unknown").blockers).toContain("plan_unavailable"); // null is not "available"
    for (const bad of ["", "../x", "a b", "x".repeat(80), "plan;drop"]) expect(sel(bad).blockers).toEqual(["plan_id_invalid"]);
    expect(sel(undefined as never).ok).toBe(false);
  });
  it("UNKNOWN UNITS block live creation: no estimate, no resource comparison, explicit unknowns", () => {
    const s = sel("g2-small", null);
    expect(s.ok).toBe(false);
    expect(s.blockers).toContain("units_unverified");
    expect(s.financial).toMatchObject({ unitsVerified: false, estimate: null, requiredBalance: null });
    expect(s.financial.resource).toMatchObject({ ramUnit: null, cpuUnit: null, priceUnit: null });
    expect(s.financial.unknownCostComponents.join(" ")).toMatch(/واحد قیمت|حداقل موجودی|زمان شروع/);
  });
  it("RAM is compared only with a verified unit; the smallest plan is not assumed sufficient", () => {
    expect(sel("g2-tiny").blockers).toContain("ram_insufficient"); // 0.25 GB = 256 MB < 512 MB
    expect(sel("g2-tiny", { ...UNITS, ram: "MB" }).blockers).toContain("ram_insufficient"); // if the operator says MB, 0.25 is far below the need — the verdict follows the declared unit
    expect(sel("g2-small", UNITS, { minRamMb: 4096 }).blockers).toContain("ram_insufficient");
  });
  it("bundle plans: explicit choice when several are available; refusal when none or invalid", () => {
    expect(sel("g2-big").blockers).toContain("bundle_plan_ambiguous");
    expect(sel("g2-big", UNITS, { bundlePlanId: "silver" })).toMatchObject({ ok: true, bundlePlanId: "silver" });
    expect(sel("g2-big", UNITS, { bundlePlanId: "gold" }).blockers).toContain("bundle_plan_unavailable");
    const noBundle = { ...CATALOGUE, bundles: {} };
    expect(selectPlan({ projection: noBundle, planId: "g2-small", units: UNITS, minRamMb: 512 }).blockers).toContain("bundle_plan_unavailable");
  });
  it("a missing price or region is reported, not invented", () => {
    const p = { ...CATALOGUE, plans: [{ ...CATALOGUE.plans[1]!, price: null }] };
    expect(selectPlan({ projection: p, planId: "g2-small", units: UNITS, minRamMb: 512 }).blockers).toContain("price_missing");
    expect(sel("g2-noregion", UNITS, { bundlePlanId: "bronze" }).notes.join(" ")).toMatch(/منطقه/);
  });
  it("platform compatibility is stated as UNKNOWN, always", () => {
    expect(sel("g2-small").notes.join(" ")).toMatch(/سازگاری پلن با پلتفرم/);
  });
});

describe("financial impact", () => {
  const plan = CATALOGUE.plans[1]!;
  it("estimates a STATED duration only from verified price unit + billing model, and labels the basis", () => {
    const hourly = financialFor(plan, plan.id, UNITS, 10);
    expect(hourly.estimate).toMatchObject({ durationHours: 10, amount: 18050, currency: "IRT" });
    expect(hourly.estimate!.basis).toMatch(/hourly_from_creation.*verified 2026-10-22/);
    expect(hourly.requiredBalance).toBe(50000);
    expect(hourly.knownOtherCosts).toEqual(["ترافیک خروجی طبق تعرفه"]);
    const monthlyPrice = financialFor(plan, plan.id, { ...UNITS, price: { currency: "IRT", per: "month" } }, 720);
    expect(monthlyPrice.estimate!.amount).toBe(1805); // 1805/720h × 720h
    const prepaid = financialFor(plan, plan.id, { ...UNITS, billing: { ...UNITS.billing, model: "monthly_prepaid" }, price: { currency: "IRT", per: "month" } }, 24);
    expect(prepaid.estimate!.amount).toBe(1805); // a whole month is charged up front
  });
  it("always lists cost components that nothing verifies (traffic, fixed IP, disks)", () => {
    const f = financialFor(plan, plan.id, UNITS);
    expect(f.unknownCostComponents.join(" ")).toMatch(/ترافیک خروجی/);
    expect(f.unknownCostComponents.join(" ")).toMatch(/IP ثابت/);
    expect(f.unknownCostComponents.join(" ")).toMatch(/دیسک/);
  });
  it("no plan or no price ⇒ no estimate", () => {
    expect(financialFor(null, "x", UNITS).estimate).toBeNull();
    expect(financialFor({ ...plan, price: null }, plan.id, UNITS).estimate).toBeNull();
  });
  it("candidates: only available plans; unverified units give NO ranking flag", () => {
    const c = listCandidates(CATALOGUE, null, 512);
    expect(c.map((x) => x.id)).toEqual(["g2-tiny", "g2-small", "g2-medium", "g2-big", "g2-noregion"]);
    expect(c.every((x) => x.recommended === null)).toBe(true);
    const v = listCandidates(CATALOGUE, UNITS, 512);
    expect(v.map((x) => [x.id, x.recommended])).toEqual([["g2-tiny", false], ["g2-small", true], ["g2-medium", true], ["g2-big", true], ["g2-noregion", true]]);
  });
});

describe("SSRF-safe probe", () => {
  const blocked = ["127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.100.100.200", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.5", "203.0.113.9", "::", "::1", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254", "::ffff:7f00:1", "64:ff9b::1", "2001:db8::1", "not-an-ip", "", "1.2.3", "999.1.1.1", "1.2.3.4.5"];
  const allowed = ["8.8.8.8", "93.184.216.34", "172.32.0.1", "11.0.0.1", "2606:4700:4700::1111", "100.63.255.255"];
  it("blocks every private, loopback, link-local, CGNAT, multicast, reserved and metadata address", () => {
    for (const ip of blocked) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of allowed) expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it("the target is built only from a validated app name and the operator's suffix; disabled without a suffix", async () => {
    expect(buildProbeHost("my-app", ["liara.run"])).toBe("my-app.liara.run");
    for (const bad of ["Bad_Name", "a", "../x", "x.evil.com", "app/../x", "app name"]) expect(buildProbeHost(bad, ["liara.run"])).toBeNull();
    expect(buildProbeHost("my-app", [])).toBeNull();
    expect((await safeProbe({ appName: "my-app", suffixes: [], path: "/health" })).outcome).toBe("disabled");
  });
  const req = (r: Awaited<ReturnType<RequestFn>>): RequestFn => async (o) => {
    // emulate the socket layer: the guarded lookup runs BEFORE any connection
    const addr = await new Promise<string | Error>((res) => o.lookup(o.host, {}, (err, a) => res(err ?? (a as string))));
    return addr instanceof Error ? { error: (addr as Error & { code?: string }).code === "ESSRF" ? "blocked" : "network" } : r;
  };
  const probe = (r: Awaited<ReturnType<RequestFn>>, addrs: string[], extra: Partial<Parameters<typeof safeProbe>[0]> = {}) => safeProbe({ appName: "my-app", suffixes: ["liara.run"], path: "/health", resolve: async () => addrs, request: req(r), ...extra });
  it("connect-time validation refuses a hostname that RESOLVES to a private/loopback/metadata address (DNS rebinding)", async () => {
    for (const ip of ["127.0.0.1", "10.1.1.1", "169.254.169.254", "::1", "fd00:ec2::254"]) expect((await probe({ status: 200, body: Buffer.from("ok"), tooLarge: false }, [ip])).outcome, ip).toBe("blocked_address");
    expect((await probe({ status: 200, body: Buffer.from("ok"), tooLarge: false }, ["8.8.8.8", "10.0.0.1"])).outcome).toBe("blocked_address"); // ANY bad address blocks
    expect((await probe({ status: 200, body: Buffer.from("ok"), tooLarge: false }, [])).outcome).toBe("blocked_address");
  });
  it("redirects are results, never followed; error statuses and oversize are reported; marker is checked", async () => {
    expect(await probe({ status: 302, body: Buffer.alloc(0), tooLarge: false }, ["8.8.8.8"])).toMatchObject({ outcome: "redirect", status: 302 });
    expect(await probe({ status: 500, body: Buffer.alloc(0), tooLarge: false }, ["8.8.8.8"])).toMatchObject({ outcome: "http_error", status: 500 });
    expect((await probe({ status: 200, body: Buffer.alloc(0), tooLarge: true }, ["8.8.8.8"])).outcome).toBe("too_large");
    expect(await probe({ status: 200, body: Buffer.from('{"app":"liara-agent-demo"}'), tooLarge: false }, ["8.8.8.8"], { marker: "liara-agent-demo" })).toMatchObject({ outcome: "ok", markerFound: true });
    expect(await probe({ status: 200, body: Buffer.from("<html>login</html>"), tooLarge: false }, ["8.8.8.8"], { marker: "liara-agent-demo" })).toMatchObject({ outcome: "ok", markerFound: false });
  });
  it("timeouts and network errors are reported; hostile paths are refused before any lookup", async () => {
    expect((await probe({ error: "timeout" }, ["8.8.8.8"])).outcome).toBe("timeout");
    expect((await probe({ error: "network" }, ["8.8.8.8"])).outcome).toBe("network");
    let looked = 0;
    for (const path of ["health", "/../etc/passwd", "//evil.example/x", "/a?x=1", "/a#f", "/a b", "/" + "a".repeat(200), "http://evil.example/"]) {
      const r = await safeProbe({ appName: "my-app", suffixes: ["liara.run"], path, resolve: async () => (looked++, ["8.8.8.8"]), request: req({ status: 200, body: Buffer.alloc(0), tooLarge: false }) });
      expect(r.outcome, path).toBe("invalid_target");
    }
    expect(looked).toBe(0);
  });
});

describe("verification ladder: unknown is never success", () => {
  const base: Snapshot = { apiAcceptedRequest: true, sourceUploaded: true, releaseId: "rel_1", releaseState: "READY", currentReleaseMatches: true, runtime: { runtime: "running", heuristic: true, appletCount: 1 }, health: { outcome: "ok", status: 200, markerFound: true, markerRequired: true }, probeConfigured: true };
  const v = (s: Partial<Snapshot>, polling = false) => verdictOf(evaluateLadder({ ...base, ...s }), { stillPolling: polling });
  it("deployed only when ALL six facts are ok", () => {
    expect(v({})).toBe("deployed");
    expect(Object.values(evaluateLadder(base)).every((x) => x === "ok")).toBe(true);
  });
  it("each missing fact prevents success (and unknown ≠ failed while polling)", () => {
    expect(v({ releaseState: null })).toBe("needs_review");
    expect(v({ releaseState: "SOMETHING_NEW" })).toBe("needs_review");
    expect(v({ releaseState: "SOMETHING_NEW" }, true)).toBe("pending");
    expect(v({ runtime: null, health: null })).toBe("needs_review");
    expect(v({ runtime: null, currentReleaseMatches: false })).toBe("needs_review"); // an older release could be the one answering
    expect(v({ runtime: null, currentReleaseMatches: null })).toBe("needs_review");
    expect(v({ runtime: null, health: { outcome: "ok", status: 200, markerFound: true, markerRequired: false } })).toBe("needs_review"); // no specific marker ⇒ a 200 proves nothing about OUR process
    expect(v({ runtime: null, health: { outcome: "timeout", status: null, markerFound: null, markerRequired: true } })).toBe("needs_review");
    expect(v({ runtime: null, releaseState: "DEPLOYING" }, true)).toBe("pending");
    expect(v({ runtime: { runtime: "unknown", heuristic: true, appletCount: 1 } })).toBe("needs_review");
    expect(v({ runtime: { runtime: "running", heuristic: true, appletCount: 0 } })).toBe("needs_review");
    expect(v({ health: null, probeConfigured: false })).toBe("needs_review");
    expect(v({ health: { outcome: "disabled", status: null, markerFound: null, markerRequired: true } })).toBe("needs_review");
    expect(v({ health: { outcome: "timeout", status: null, markerFound: null, markerRequired: true } })).toBe("needs_review");
    expect(v({ releaseId: null })).toBe("needs_review");
    expect(v({ apiAcceptedRequest: false })).toBe("needs_review");
    expect(v({ sourceUploaded: false })).toBe("needs_review");
  });
  it("a configured response marker MUST be found; an unmarked 200 is not health", () => {
    expect(v({ health: { outcome: "ok", status: 200, markerFound: null, markerRequired: true } })).toBe("needs_review");
    expect(v({ health: { outcome: "ok", status: 200, markerFound: false, markerRequired: true } })).toBe("failed");
    expect(v({ health: { outcome: "ok", status: 200, markerFound: null, markerRequired: false } })).toBe("deployed");
  });
  it("failure signals fail the ladder", () => {
    for (const st of ["FAILED", "CANCELED", "TIMEDOUT", "UNHEALTHY", "failed"]) expect(v({ releaseState: st }), st).toBe("failed");
    expect(v({ health: { outcome: "http_error", status: 502, markerFound: null, markerRequired: true } })).toBe("failed");
    expect(v({ runtime: { runtime: "restarting", heuristic: true, appletCount: 1 } })).toBe("failed");
  });
  it("DEPLOYING is in progress, not success; restarting during DEPLOYING is not judged yet", () => {
    expect(v({ releaseState: "DEPLOYING", health: null }, true)).toBe("pending");
    expect(v({ releaseState: "DEPLOYING", runtime: { runtime: "restarting", heuristic: true, appletCount: 1 }, health: null }, true)).toBe("pending");
    expect(classifyReleaseState("ready")).toBe("ready");
    expect(classifyReleaseState(null)).toBe("unknown");
  });
  it("applets endpoint unreadable (the real API answered HTTP 500): the runtime is inferred ONLY from a marker-verified answer of the CURRENT, READY release — never over a readable stopped/restarting/unknown applet list", () => {
    const real: Snapshot = { ...base, runtime: null, currentReleaseMatches: true, health: { outcome: "ok", status: 200, markerFound: true, markerRequired: true } };
    expect(evaluateLadder(real)).toEqual({ apiAcceptedRequest: "ok", sourceUploaded: "ok", releaseCreated: "ok", buildCompleted: "ok", runtimeStarted: "ok", httpHealthVerified: "ok" });
    expect(verdictOf(evaluateLadder(real), { stillPolling: false })).toBe("deployed");
    expect(evaluateLadder({ ...real, runtime: { runtime: "unknown", heuristic: true, appletCount: 1 } }).runtimeStarted).toBe("unknown");
    expect(evaluateLadder({ ...real, runtime: { runtime: "stopped", heuristic: true, appletCount: 1 } }).runtimeStarted).toBe("failed");
    expect(evaluateLadder({ ...real, releaseState: "UNHEALTHY" }).runtimeStarted).toBe("failed");
  });
  it("provenance of the runtime fact: observed (applets read) / inferred (applets unreadable + marker-verified answer) / unknown — and the ladder is identical to evaluateLadder", () => {
    const observed = assess(base);
    expect(observed.evidence).toEqual({ runtime: "observed", appletsReadable: true });
    const inferred = assess({ ...base, runtime: null });
    expect(inferred.evidence).toEqual({ runtime: "inferred", appletsReadable: false });
    expect(inferred.ladder.runtimeStarted).toBe("ok");
    const unknownUnreadable = assess({ ...base, runtime: null, health: { outcome: "network", status: null, markerFound: null, markerRequired: true } });
    expect(unknownUnreadable.evidence).toEqual({ runtime: "unknown", appletsReadable: false });
    expect(unknownUnreadable.ladder.runtimeStarted).toBe("unknown");
    expect(assess({ ...base, runtime: { runtime: "unknown", heuristic: true, appletCount: 1 } }).evidence).toEqual({ runtime: "unknown", appletsReadable: true });
    expect(assess({ ...base, runtime: { runtime: "stopped", heuristic: true, appletCount: 1 } }).evidence.runtime).toBe("observed"); // a readable "stopped" is an observation (of a failure)
    for (const s of [base, { ...base, runtime: null }, { ...base, releaseState: "DEPLOYING", health: null }]) expect(assess(s).ladder).toEqual(evaluateLadder(s));
  });
  it("provenance details: a snapshot with an observation time records source/outcome/status/marker/category/duration; 'no probe ran' is NULL; without a time nothing is fabricated", () => {
    const at = "2026-10-23T08:12:12.000Z";
    const probed = assess({ ...base, runtime: null, observedAt: at, applets: { readable: false, failure: "upstream_error" }, health: { outcome: "ok", status: 200, markerFound: true, markerRequired: true, failure: null, durationMs: 41 } });
    expect(probed.evidence).toEqual({ runtime: "inferred", appletsReadable: false, observedAt: at, health: { source: "http_probe", observedAt: at, outcome: "ok", status: 200, markerRequired: true, markerMatched: true, failure: null, durationMs: 41 }, applets: { observedAt: at, readable: false, runtimeClass: null, appletCount: null, failure: "upstream_error" } });
    expect(assess({ ...base, observedAt: at, health: null }).evidence.health).toBeNull(); // no probe ran in that observation
    const legacy = assess(base).evidence; // no observation time supplied ⇒ no timestamp, no health, no applets detail is invented
    expect(legacy).toEqual({ runtime: "observed", appletsReadable: true });
    expect(assess({ ...base, observedAt: at, runtime: { runtime: "running", heuristic: true, appletCount: 2 } }).evidence.applets).toEqual({ observedAt: at, readable: true, runtimeClass: "running", appletCount: 2, failure: null });
  });
  it("build completed does not imply runtime started, and runtime started does not imply health", () => {
    const l = evaluateLadder({ ...base, releaseState: "DEPLOYING", runtime: null, health: null });
    expect(l).toMatchObject({ buildCompleted: "ok", runtimeStarted: "unknown", httpHealthVerified: "unknown" });
  });
});

describe("write contract", () => {
  it("strict schemas: unknown members and malformed values are refused", () => {
    const ok = { name: "my-app", planID: "g2-small", platform: "next", bundlePlanID: "bronze", network: "net_demo_1" };
    expect(CreateAppRequestSchema.safeParse(ok).success).toBe(true);
    for (const bad of [{ ...ok, extra: 1 }, { ...ok, name: "Bad Name" }, { ...ok, platform: "docker" }, { ...ok, planID: "../x" }, { ...ok, network: "" }, { ...ok, bundlePlanID: undefined }]) expect(CreateAppRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    const rel = { sourceID: "src_0001_demo", port: 3000, type: "next", platformConfig: {}, build: { cache: true }, gitInfo: { branch: null, message: null, commit: null, committedAt: null, remote: null, author: { email: null, name: null }, tags: [] } };
    expect(CreateReleaseRequestSchema.safeParse(rel).success).toBe(true);
    for (const bad of [{ ...rel, port: 0 }, { ...rel, port: 70000 }, { ...rel, port: 3000.5 }, { ...rel, platformConfig: { x: 1 } }, { ...rel, sourceID: "a b" }, { ...rel, type: "node" }, { ...rel, envs: { A: "x" } }]) expect(CreateReleaseRequestSchema.safeParse(bad).success).toBe(false);
  });
  it("classifies by status ONLY: definite rejections vs unknown outcomes", () => {
    for (const [s, k, c] of [[400, "rejected", "bad_request"], [401, "rejected", "unauthorized"], [402, "rejected", "insufficient_balance"], [403, "rejected", "forbidden"], [404, "rejected", "not_found"], [409, "rejected", "already_exists"], [413, "rejected", "payload_too_large"], [429, "rejected", "rate_limited"], [418, "rejected", "rejected_other"], [408, "unknown_outcome", "timeout"], [500, "unknown_outcome", "server_error"], [502, "unknown_outcome", "server_error"], [302, "unknown_outcome", "unexpected_redirect"]] as const) expect(classifyStatus(s), String(s)).toEqual({ kind: k, code: c });
  });
});

describe("the write client (injected fetch; nothing real is contacted)", () => {
  const mk = (handler: (url: URL, init: RequestInit) => Response | Promise<Response>, over: Record<string, unknown> = {}) => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetchImpl = (async (input: URL, init: RequestInit) => {
      calls.push({ url: new URL(String(input)), init });
      return handler(new URL(String(input)), init);
    }) as unknown as typeof fetch;
    const client = new LiaraWriteClient({ baseUrl: new URL("https://api.liara.ir"), token: new Secret(CANARY.token), teamId: "team_demo_1", timeoutMs: 5000, uploadTimeoutMs: 8000, fetchImpl, ...over });
    return { client, calls };
  };
  const app = { name: "my-app", planID: "g2-small", platform: "next" as const, bundlePlanID: "bronze", network: "net_demo_1" };
  it("createApp: one POST to /v1/projects with exactly the contract body, bearer auth, team query, no redirects", async () => {
    const { client, calls } = mk(() => new Response("", { status: 200 }));
    const r = await client.createApp(app);
    expect(r).toEqual({ ok: true, status: 200, data: { accepted: true } });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.init.method).toBe("POST");
    expect(c.init.redirect).toBe("manual");
    expect(c.url.origin + c.url.pathname).toBe("https://api.liara.ir/v1/projects");
    expect(c.url.searchParams.get("teamID")).toBe("team_demo_1");
    expect(JSON.parse(String(c.init.body))).toEqual(app);
    expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CANARY.token}`);
    expect((c.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
  it("uploadSource: multipart `file` to /v2/projects/{name}/sources; the archive bytes are sent verbatim", async () => {
    const { client, calls } = mk(() => new Response(JSON.stringify({ sourceID: "src_0001_demo" }), { status: 200, headers: { "content-type": "application/json" } }));
    const bytes = Buffer.from("fake-archive-bytes");
    const r = await client.uploadSource("my-app", bytes);
    expect(r).toEqual({ ok: true, status: 200, data: { sourceID: "src_0001_demo" } });
    const c = calls[0]!;
    expect(c.url.pathname).toBe("/v2/projects/my-app/sources");
    const form = c.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const f = form.get("file") as File;
    expect(f.name).toBe("source.tar.gz");
    expect(Buffer.from(await f.arrayBuffer()).equals(bytes)).toBe(true);
    expect((c.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined(); // set by fetch with the multipart boundary
  });
  it("createRelease: JSON body with sourceID, port, type and the CLI-observed platformConfig/build", async () => {
    const { client, calls } = mk(() => new Response(JSON.stringify({ releaseID: "rel_0001_demo" }), { status: 200 }));
    const body = { sourceID: "src_0001_demo", port: 3000, type: "next" as const, platformConfig: {}, build: { cache: true as const }, gitInfo: { branch: null, message: null, commit: null, committedAt: null, remote: null, author: { email: null, name: null }, tags: [] } };
    expect(await client.createRelease("my-app", body)).toEqual({ ok: true, status: 200, data: { releaseID: "rel_0001_demo" } });
    expect(calls[0]!.url.pathname).toBe("/v2/projects/my-app/releases");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(body);
  });
  it("never retries: one attempt per call whatever the answer", async () => {
    for (const status of [500, 502, 503, 429, 408]) {
      const { client, calls } = mk(() => new Response("", { status }));
      await client.createApp(app);
      expect(calls, String(status)).toHaveLength(1);
    }
    const t = mk(() => Promise.reject(Object.assign(new Error("x"), { name: "TimeoutError" })));
    expect(await t.client.createApp(app)).toMatchObject({ ok: false, kind: "unknown_outcome", code: "timeout" });
    expect(t.calls).toHaveLength(1);
    const n = mk(() => Promise.reject(new Error("ECONNRESET")));
    expect(await n.client.createRelease("my-app", { sourceID: "src_0001_demo", port: 3000, type: "next", platformConfig: {}, build: { cache: true }, gitInfo: { branch: null, message: null, commit: null, committedAt: null, remote: null, author: { email: null, name: null }, tags: [] } })).toMatchObject({ ok: false, kind: "unknown_outcome", code: "network" });
    expect(n.calls).toHaveLength(1);
  });
  it("a 2xx with an unreadable/oversized/invalid body is an UNKNOWN outcome, never success", async () => {
    expect(await mk(() => new Response("<html>", { status: 200 })).client.uploadSource("my-app", Buffer.from("x"))).toMatchObject({ ok: false, kind: "unknown_outcome", code: "malformed_response" });
    expect(await mk(() => new Response(JSON.stringify({ sourceID: "bad id!" }), { status: 200 })).client.uploadSource("my-app", Buffer.from("x"))).toMatchObject({ ok: false, kind: "unknown_outcome" });
    expect(await mk(() => new Response("x".repeat(200_000), { status: 200 })).client.createRelease("my-app", { sourceID: "src_0001_demo", port: 3000, type: "next", platformConfig: {}, build: { cache: true }, gitInfo: { branch: null, message: null, commit: null, committedAt: null, remote: null, author: { email: null, name: null }, tags: [] } })).toMatchObject({ ok: false, kind: "unknown_outcome", code: "malformed_response" });
    expect(await mk(() => new Response(JSON.stringify({}), { status: 200 })).client.createRelease("my-app", { sourceID: "src_0001_demo", port: 3000, type: "next", platformConfig: {}, build: { cache: true }, gitInfo: { branch: null, message: null, commit: null, committedAt: null, remote: null, author: { email: null, name: null }, tags: [] } })).toMatchObject({ ok: false, kind: "unknown_outcome" });
  });
  it("maps statuses (rejected vs unknown); a redirect is never followed and is an unknown outcome", async () => {
    expect(await mk(() => new Response("", { status: 409 })).client.createApp(app)).toMatchObject({ ok: false, kind: "rejected", code: "already_exists" });
    expect(await mk(() => new Response("", { status: 402 })).client.createApp(app)).toMatchObject({ ok: false, kind: "rejected", code: "insufficient_balance" });
    const red = mk(() => new Response(null, { status: 307, headers: { location: "https://evil.example" } }));
    expect(await red.client.createApp(app)).toMatchObject({ ok: false, kind: "unknown_outcome", code: "unexpected_redirect" });
    expect(red.calls).toHaveLength(1);
  });
  it("only trusted https hosts; invalid inputs are refused BEFORE any request", async () => {
    expect(() => new LiaraWriteClient({ baseUrl: new URL("https://evil.example"), token: new Secret("x"), teamId: null, timeoutMs: 1000, uploadTimeoutMs: 1000 })).toThrow();
    expect(() => new LiaraWriteClient({ baseUrl: new URL("http://api.liara.ir"), token: new Secret("x"), teamId: null, timeoutMs: 1000, uploadTimeoutMs: 1000 })).toThrow();
    const { client, calls } = mk(() => new Response("", { status: 200 }));
    await expect(client.createApp({ ...app, name: "../x" })).rejects.toThrow();
    await expect(client.createApp({ ...app, extra: 1 } as never)).rejects.toThrow();
    await expect(client.uploadSource("../x", Buffer.from("x"))).rejects.toThrow();
    await expect(client.uploadSource("my-app", Buffer.alloc(0))).rejects.toThrow();
    await expect(client.createRelease("A b", { sourceID: "src_0001_demo", port: 3000, type: "next", platformConfig: {}, build: { cache: true }, gitInfo: { branch: null, message: null, commit: null, committedAt: null, remote: null, author: { email: null, name: null }, tags: [] } })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it("the token never appears in the serialised client or in thrown errors; a personal account sends no teamID", async () => {
    const { client, calls } = mk(() => new Response("", { status: 200 }), { teamId: null });
    expect(JSON.stringify(client)).not.toContain(CANARY.token);
    await client.createApp(app);
    expect(calls[0]!.url.searchParams.has("teamID")).toBe(false);
  });
});
