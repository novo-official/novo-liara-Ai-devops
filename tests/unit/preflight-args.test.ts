import { describe, expect, it } from "vitest";
import { parsePreflightArgs, plannedRequests, SUPPORTED_FLAGS } from "@/server/live/preflight-args";

const ok = (argv: string[]) => {
  const r = parsePreflightArgs(argv);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.args;
};
const errs = (argv: string[]) => {
  const r = parsePreflightArgs(argv);
  return r.ok ? [] : r.errors;
};

describe("preflight arguments: explicit, validated, fail-closed", () => {
  it("--app=<name> is EXPLICITLY supported and selects the existing-application mode", () => {
    expect(ok(["--app=liara-agent-demo"])).toMatchObject({ mode: "existing_app", app: "liara-agent-demo", newApp: null, approve: false, includeNetworks: false, budget: 8 });
    expect(ok(["--app=liara-agent-demo", "--approve-live-readonly", "--include-networks", "--budget=10"])).toMatchObject({ mode: "existing_app", approve: true, includeNetworks: true, budget: 10 });
  });
  it("no --app preserves the account-only flow; --new-app preserves the old creation semantics", () => {
    expect(ok([])).toMatchObject({ mode: "account", app: null, newApp: null });
    expect(ok(["--include-networks", "--approve-live-readonly"])).toMatchObject({ mode: "account", includeNetworks: true, approve: true });
    expect(ok(["--new-app=my-new-app", "--plan=g2-small", "--bundle=bronze"])).toMatchObject({ mode: "new_app", newApp: "my-new-app", plan: "g2-small", bundle: "bronze" });
  });
  it("unknown flags are errors (never silently ignored) and the error lists what is supported", () => {
    for (const bad of ["--surprise", "--appp=x", "--App=x", "--delete", "--yes", "--approve", "--approve-live-write", "--api-token=abc", "--budget-x=1"]) {
      const e = errs(["--app=liara-agent-demo", bad]);
      expect(e.length, bad).toBeGreaterThan(0);
      expect(e.join(" "), bad).toMatch(/unsupported flag|unexpected argument/);
    }
    expect(errs(["--zzz"]).join(" ")).toContain("--app");
    for (const f of SUPPORTED_FLAGS) expect(errs(["--zzz"]).join(" ")).toContain("--" + f);
  });
  it("positional or malformed tokens, single dashes and stray values are errors", () => {
    for (const bad of ["liara-agent-demo", "-a", "-app=x", "app=x", "--", "---app=x", "--app liara-agent-demo", "—app=x", ""]) expect(errs([bad]).length, JSON.stringify(bad)).toBeGreaterThan(0);
    expect(errs(["--app", "liara-agent-demo"]).length).toBeGreaterThan(0); // space-separated value is not accepted (it would be a positional)
  });
  it("missing, empty, malformed or hostile values are errors", () => {
    for (const v of ["--app", "--app=", "--app=Bad_Name", "--app=a", "--app=-x", "--app=x;rm", "--app=../etc", "--app=UPPER", "--app=" + "a".repeat(70)]) expect(errs([v]).length, v).toBeGreaterThan(0);
    expect(errs(["--approve-live-readonly=yes"]).join(" ")).toMatch(/takes no value/);
    expect(errs(["--include-networks=1"]).join(" ")).toMatch(/takes no value/);
    for (const b of ["--budget=3", "--budget=13", "--budget=x", "--budget=", "--budget=1.5", "--budget=-5", "--budget=100"]) expect(errs([b]).length, b).toBeGreaterThan(0);
  });
  it("duplicates and contradictory combinations are errors", () => {
    expect(errs(["--app=aa-bb", "--app=cc-dd"]).join(" ")).toMatch(/more than once/);
    expect(errs(["--approve-live-readonly", "--approve-live-readonly"]).join(" ")).toMatch(/more than once/);
    expect(errs(["--app=aa-bb", "--new-app=cc-dd"]).join(" ")).toMatch(/cannot be combined/);
    expect(errs(["--app=aa-bb", "--plan=g2-small"]).join(" ")).toMatch(/--new-app/);
    expect(errs(["--bundle=bronze"]).join(" ")).toMatch(/--new-app/);
    expect(errs(["--new-app=aa-bb", "--plan=../x"]).join(" ")).toMatch(/valid plan id/);
  });
  it("collects EVERY error, not just the first", () => {
    expect(errs(["--bogus", "--app=", "--budget=1"]).length).toBeGreaterThanOrEqual(3);
  });
});

describe("planned requests: every GET is listed, GET only, exact", () => {
  const ctx = { teamScoped: true, allowUndocumented: false, appInScope: true };
  it("existing-app mode plans exactly: list, account (team), instance identity, release baseline", () => {
    const p = plannedRequests(ok(["--app=liara-agent-demo"]), ctx);
    expect(p.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/projects", "GET /v1/me", "GET /v1/projects/liara-agent-demo", "GET /v1/projects/liara-agent-demo/releases?page=1&count=10"]);
    expect(p.every((r) => r.willSend && r.contract === "documented")).toBe(true);
    expect(p[2]!.purpose).toMatch(/instance id.*creation time.*plan.*platform.*network.*default domain/);
    expect(p[3]!.purpose).toMatch(/release baseline/);
  });
  it("an application outside the allowlist is shown as SKIPPED with the reason (not silently dropped)", () => {
    const p = plannedRequests(ok(["--app=liara-agent-demo"]), { ...ctx, appInScope: false });
    expect(p.filter((r) => !r.willSend).map((r) => r.path)).toEqual(["/v1/projects/liara-agent-demo", "/v1/projects/liara-agent-demo/releases?page=1&count=10"]);
    expect(p.find((r) => !r.willSend)!.skipReason).toMatch(/LIARA_ALLOWED_APPS/);
  });
  it("--include-networks adds the UNDOCUMENTED endpoint and needs the opt-in", () => {
    const a = plannedRequests(ok(["--app=liara-agent-demo", "--include-networks"]), ctx);
    expect(a.at(-1)).toMatchObject({ path: "/v1/networks", contract: "observed", willSend: false });
    expect(plannedRequests(ok(["--app=liara-agent-demo", "--include-networks"]), { ...ctx, allowUndocumented: true }).at(-1)!.willSend).toBe(true);
  });
  it("the account flow is unchanged (list, me, billing for personal accounts, optional networks)", () => {
    expect(plannedRequests(ok([]), { ...ctx, appInScope: null }).map((r) => r.path)).toEqual(["/v1/projects", "/v1/me"]);
    expect(plannedRequests(ok([]), { teamScoped: false, allowUndocumented: false, appInScope: null }).map((r) => r.path)).toEqual(["/v1/projects", "/v1/me", "/v1/billing"]);
  });
  it("no mode can plan anything but GET, and never a write path", () => {
    for (const argv of [[], ["--app=liara-agent-demo", "--include-networks"], ["--new-app=my-new-app"]]) for (const r of plannedRequests(ok(argv), { teamScoped: false, allowUndocumented: true, appInScope: true })) {
      expect(r.method).toBe("GET");
      expect(r.path).not.toMatch(/sources|actions|resize|delete|restart|scale/);
    }
  });
});
