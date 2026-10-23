import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The probe's DEFAULT request implementation (node:https) exercised against a MOCK of node:https — no socket is ever opened (the suite's network guard would throw).
 * This proves the implementation's behaviour under the simulated conditions below; it is NOT a test of a real network socket.
 */
class FakeReq extends EventEmitter {
  destroyed = false;
  ended = false;
  destroy = vi.fn(() => { this.destroyed = true; return this; });
  end = vi.fn(() => { this.ended = true; return this; });
}
class FakeRes extends EventEmitter {
  complete = false;
  destroyed = false;
  statusCode: number | undefined;
  headers: Record<string, string> = {};
  destroy = vi.fn(() => { this.destroyed = true; queueMicrotask(() => this.emit("close")); return this; });
}
const h = vi.hoisted(() => ({ calls: [] as { opts: Record<string, unknown>; req: unknown }[], onResponse: undefined as undefined | ((req: unknown, cb: (res: unknown) => void) => void) }));
vi.mock("node:https", () => ({
  request: (opts: Record<string, unknown>, cb: (res: unknown) => void) => {
    const req = new FakeReq();
    h.calls.push({ opts, req });
    queueMicrotask(() => h.onResponse?.(req, cb));
    return req;
  },
}));

import { safeProbe } from "@/server/live/probe";

const probe = (over: Record<string, unknown> = {}) => safeProbe({ appName: "liara-agent-demo", suffixes: ["liara.run"], path: "/health", marker: "liara-agent-demo", resolve: async () => ["185.208.1.1"], timeoutMs: 80, ...over });
const reply = (status: number, chunks: string[], o: { end?: boolean; headers?: Record<string, string> } = {}) => (_req: unknown, cb: (res: unknown) => void) => {
  const res = new FakeRes();
  res.statusCode = status;
  res.headers = o.headers ?? {};
  cb(res);
  for (const c of chunks) res.emit("data", Buffer.from(c));
  if (o.end !== false) { res.complete = true; res.emit("end"); res.emit("close"); }
};
const last = () => h.calls[h.calls.length - 1]!;
const lastReq = () => last().req as FakeReq;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { h.calls.length = 0; h.onResponse = undefined; });

describe("request shape", () => {
  it("one GET over https:443, no agent reuse, no body, a fixed non-sensitive header set, the guarded lookup, and the socket idle timeout", async () => {
    h.onResponse = reply(200, ['{"app":"liara-agent-demo"}']);
    const r = await probe();
    expect(r).toMatchObject({ outcome: "ok", status: 200, markerFound: true });
    expect(h.calls).toHaveLength(1);
    const o = last().opts;
    expect(o).toMatchObject({ host: "liara-agent-demo.liara.run", port: 443, path: "/health", method: "GET", agent: false, timeout: 80 });
    expect(typeof o.lookup).toBe("function");
    const headers = Object.keys(o.headers as object).map((k) => k.toLowerCase()).sort();
    expect(headers).toEqual(["accept", "connection", "user-agent"]);
    expect(JSON.stringify(o)).not.toMatch(/authorization|cookie|bearer/i);
    expect("followRedirects" in o || "maxRedirects" in o).toBe(false);
    expect(lastReq().end).toHaveBeenCalledTimes(1);
  });
  it("a host the guard refuses (not under a trusted suffix) never reaches node:https", async () => {
    expect(await probe({ suffixes: [] })).toMatchObject({ outcome: "disabled" });
    expect(await probe({ appName: "bad name!" })).toMatchObject({ outcome: "invalid_target" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("redirects stay disabled", () => {
  it("a 3xx answer is reported as a redirect, the Location header is never followed (exactly one request), and it is not a pass", async () => {
    h.onResponse = reply(302, [""], { headers: { location: "http://169.254.169.254/latest/meta-data" } });
    const r = await probe();
    expect(r).toMatchObject({ outcome: "redirect", status: 302, markerFound: null, failure: "redirect" });
    expect(h.calls).toHaveLength(1);
  });
});

describe("response size cap (4 KiB)", () => {
  it("exactly 4096 bytes is accepted; one more byte aborts the read, destroys the response and is reported as too_large (never as ok)", async () => {
    h.onResponse = reply(200, ["x".repeat(4096)]);
    expect(await probe({ marker: undefined })).toMatchObject({ outcome: "ok", status: 200 });
    h.onResponse = (_req, cb) => {
      const res = new FakeRes();
      res.statusCode = 200;
      cb(res);
      res.emit("data", Buffer.from("x".repeat(4000)));
      res.emit("data", Buffer.from("liara-agent-demo".repeat(10))); // crosses the cap: this chunk must not be used
      res.emit("data", Buffer.from("never-read"));
      (last().req as FakeReq & { res?: FakeRes }).res = res;
    };
    const r = await probe();
    expect(r).toMatchObject({ outcome: "too_large", status: 200, markerFound: null, failure: "too_large" });
    expect(((lastReq() as unknown) as { res: FakeRes }).res.destroy).toHaveBeenCalled();
  });
});

describe("TOTAL deadline (not just an idle timeout)", () => {
  it("a slow-drip answer that keeps the socket 'active' is cut off at the deadline: the request is destroyed and the outcome is timeout", async () => {
    let timer: NodeJS.Timeout | undefined;
    h.onResponse = (_req, cb) => {
      const res = new FakeRes();
      res.statusCode = 200;
      cb(res);
      timer = setInterval(() => res.emit("data", Buffer.from(".")), 10);
    };
    const t0 = Date.now();
    const r = await probe({ timeoutMs: 100 });
    clearInterval(timer);
    expect(r).toMatchObject({ outcome: "timeout", status: null, markerFound: null, failure: "timeout" });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(lastReq().destroy).toHaveBeenCalled();
  });
  it("a response that never starts is cut off at the deadline as well", async () => {
    h.onResponse = () => undefined;
    const r = await probe({ timeoutMs: 60 });
    expect(r).toMatchObject({ outcome: "timeout" });
    expect(lastReq().destroy).toHaveBeenCalledTimes(1);
  });
  it("the socket's own idle 'timeout' event is classified the same way (timeout) and destroys the request", async () => {
    h.onResponse = (req) => { setTimeout(() => (req as FakeReq).emit("timeout"), 5); };
    const r = await probe({ timeoutMs: 5000 });
    expect(r).toMatchObject({ outcome: "timeout", failure: "timeout" });
    expect(lastReq().destroy).toHaveBeenCalled();
  });
  it("the deadline timer is cleared once the probe has settled: a finished request is never destroyed late", async () => {
    h.onResponse = reply(200, ['{"app":"liara-agent-demo"}']);
    await probe({ timeoutMs: 40 });
    await sleep(80);
    expect(lastReq().destroy).not.toHaveBeenCalled();
  });
});

describe("abort signal", () => {
  it("aborting mid-flight destroys the request at once and reports 'cancelled' (not a timeout, not a network failure)", async () => {
    const ac = new AbortController();
    h.onResponse = () => { setTimeout(() => ac.abort(), 10); };
    const t0 = Date.now();
    const r = await probe({ signal: ac.signal, timeoutMs: 5000 });
    expect(r).toMatchObject({ outcome: "cancelled", failure: "cancelled", status: null });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(lastReq().destroy).toHaveBeenCalledTimes(1);
  });
  it("an already-aborted signal never opens a request", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await probe({ signal: ac.signal })).toMatchObject({ outcome: "cancelled" });
    expect(h.calls).toHaveLength(0);
  });
  it("aborting after the probe finished does nothing (the listener was removed)", async () => {
    const ac = new AbortController();
    h.onResponse = reply(200, ['{"app":"liara-agent-demo"}']);
    expect(await probe({ signal: ac.signal })).toMatchObject({ outcome: "ok" });
    ac.abort();
    expect(lastReq().destroy).not.toHaveBeenCalled();
  });
});

describe("failure classification is consistent", () => {
  const fail = async (code: string | undefined) => {
    h.onResponse = (req) => { const e = Object.assign(new Error("secret-host-detail"), code ? { code } : {}); (req as FakeReq).emit("error", e); };
    return probe();
  };
  it.each([
    ["ENOTFOUND", "network", "dns"], ["EAI_AGAIN", "network", "dns"], ["EDNS", "network", "dns"],
    ["ECONNREFUSED", "network", "connection"], ["ECONNRESET", "network", "connection"], ["ETIMEDOUT", "network", "connection"], [undefined, "network", "connection"],
    ["CERT_HAS_EXPIRED", "network", "tls"], ["ERR_TLS_CERT_ALTNAME_INVALID", "network", "tls"], ["DEPTH_ZERO_SELF_SIGNED_CERT", "network", "tls"],
    ["ESSRF", "blocked_address", "blocked_address"],
  ] as const)("%s ⇒ %s / %s (and the error text is never kept)", async (code, outcome, failure) => {
    const r = await fail(code);
    expect(r).toMatchObject({ outcome, failure, status: null, markerFound: null });
    expect(JSON.stringify(r)).not.toContain("secret-host-detail");
  });
  it("a response that is cut off before its end is a network failure, not a partial pass", async () => {
    h.onResponse = (_req, cb) => {
      const res = new FakeRes();
      res.statusCode = 200;
      cb(res);
      res.emit("data", Buffer.from('{"app":"liara-agent-demo"'));
      res.emit("close"); // closed without 'end': res.complete stays false
    };
    expect(await probe()).toMatchObject({ outcome: "network", failure: "connection", markerFound: null });
  });
  it("an error event on the response itself is a network failure", async () => {
    h.onResponse = (_req, cb) => { const res = new FakeRes(); res.statusCode = 200; cb(res); res.emit("error", new Error("boom")); };
    expect(await probe()).toMatchObject({ outcome: "network", failure: "connection" });
  });
  it("only the FIRST outcome counts: a late error after a finished answer changes nothing", async () => {
    h.onResponse = reply(200, ['{"app":"liara-agent-demo"}']);
    const r = await probe();
    lastReq().emit("error", Object.assign(new Error("late"), { code: "ECONNRESET" }));
    expect(r).toMatchObject({ outcome: "ok" });
  });
});
