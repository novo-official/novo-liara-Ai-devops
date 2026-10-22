import { beforeEach, describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { redactDeep, redactText, redactUrl, REDACTED } from "@/server/security/redact";
import { Pseudonymizer } from "@/server/security/pseudonym";
import { __resetSecretsForTests, registerSecret, Secret } from "@/server/security/secret";

beforeEach(() => __resetSecretsForTests());

describe("redactText", () => {
  it.each([
    ["Authorization: Bearer abc123def456ghi789", "abc123def456ghi789"],
    ["curl -H 'authorization: Basic dXNlcjpwYXNz'", "dXNlcjpwYXNz"],
    ["token=sk_live_abcdefghijklmnop1234", "sk_live_abcdefghijklmnop1234"],
    ['{"password":"hunter2-hunter2"}', "hunter2-hunter2"],
    ["DATABASE_URL=postgres://app:S3cretPass99@db:5432/x", "S3cretPass99"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcDEF123_-xyz", "eyJhbGciOiJIUzI1NiJ9"],
    ["key AKIAABCDEFGHIJKLMNOP end", "AKIAABCDEFGHIJKLMNOP"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----", "MIIEabc"],
    ["-----BEGIN PRIVATE KEY-----\nMIIEtruncated", "MIIEtruncated"],
    ["contact someone@example.com now", "someone@example.com"],
    ["blob Zx9kQ2mP7vL4nR8tY1wB5cD3fG6hJ0sA2eU9iO4p", "Zx9kQ2mP7vL4nR8tY1wB5cD3fG6hJ0sA2eU9iO4p"],
    ["api_key: 'my-very-secret-value'", "my-very-secret-value"],
  ])("masks secrets in %s", (input, secret) => {
    const out = redactText(input);
    expect(out).not.toContain(secret);
    expect(out).toMatch(/REDACTED/);
  });

  it("keeps ordinary text and 40-char git SHAs", () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    expect(redactText(`GET /products 200 12ms commit ${sha}`)).toBe(`GET /products 200 12ms commit ${sha}`);
    expect(redactText("سلام دنیا — خطای ۵۰۰")).toBe("سلام دنیا — خطای ۵۰۰");
  });

  it("strips ANSI escapes, control and bidi-override characters", () => {
    expect(redactText("\u001b[31mERROR\u001b[0m boom")).toBe("ERROR boom");
    expect(redactText("a‮b\u0000c")).toBe("abc");
  });

  it("masks registered exact secrets (env values / tokens) as whole tokens, without storing them", () => {
    registerSecret("ENVCANARYvalue-9f3k2");
    expect(redactText("crash: value=ENVCANARYvalue-9f3k2 end")).not.toContain("ENVCANARYvalue-9f3k2");
    expect(redactText("crash: ENVCANARYvalue-9f3k2")).toContain(REDACTED);
    registerSecret("abc"); // too short: ignored, to avoid shredding logs
    expect(redactText("abc def")).toBe("abc def");
  });

  it("truncates to maxLength", () => {
    const out = redactText("x".repeat(500), { maxLength: 50 });
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("is not vulnerable to catastrophic backtracking on long adversarial input", () => {
    const evil = "a".repeat(100_000) + "=";
    const evil2 = ("token" + "-".repeat(50)).repeat(2000);
    const t0 = performance.now();
    redactText(evil);
    redactText(evil2);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("is idempotent and leaves no fragments when rules overlap", () => {
    const line = 'Authorization: Bearer abcdef1234567890SIMULATEDTOKEN contact admin@example.invalid';
    const once = redactText(line);
    expect(once).toBe("Authorization: [REDACTED] contact [REDACTED:EMAIL]");
    expect(redactText(once)).toBe(once);
    const kv = redactText("password=hunter2hunter2 next");
    expect(redactText(kv)).toBe(kv);
  });

  it("returns an empty string for non-strings", () => {
    expect(redactText(undefined)).toBe("");
    expect(redactText(42)).toBe("");
  });
});

describe("redactDeep / redactUrl / Secret", () => {
  it("masks sensitive keys and scrubs nested strings", () => {
    const out = redactDeep({ ok: "fine", password: "p", nested: { Authorization: "Bearer xyzxyzxyz1234", list: ["token=abc123456789"] } });
    expect(JSON.stringify(out)).not.toMatch(/xyzxyzxyz1234|abc123456789/);
    expect(out.password).toBe(REDACTED);
    expect(out.ok).toBe("fine");
  });

  it("bounds recursion depth", () => {
    let o: Record<string, unknown> = {};
    const root = o;
    for (let i = 0; i < 50; i++) {
      o.n = {};
      o = o.n as Record<string, unknown>;
    }
    expect(() => redactDeep(root)).not.toThrow();
  });

  it("redactUrl drops credentials/fragments and masks sensitive query params", () => {
    const out = redactUrl("https://user:pw@host.example/path?token=abc&page=2#frag");
    expect(out).not.toMatch(/user|pw|abc|frag/);
    expect(out).toContain("page=2");
  });

  it("Secret never serialises or inspects its value", () => {
    const s = new Secret("super-secret-value");
    expect(JSON.stringify({ s })).toBe('{"s":"[REDACTED]"}');
    expect(String(s)).toBe("[REDACTED]");
    expect(`${s}`).toBe("[REDACTED]");
    expect(inspect(s)).not.toContain("super-secret-value");
    expect(inspect({ nested: s })).not.toContain("super-secret-value");
    expect(s.reveal()).toBe("super-secret-value");
  });
});

describe("connection strings, credentials in URLs, cookies and shareable output", () => {
  it.each([
    ["postgres://app:Pw12345x@db.internal:5432/shop", "Pw12345x"],
    ["mysql://root:r00tpass@10.0.0.4/db", "r00tpass"],
    ["redis://:hunter2hunter2@cache:6379", "hunter2hunter2"],
    ["mongodb+srv://u:p4ssw0rd@cluster0.example.net/x", "p4ssw0rd"],
    ["amqps://guest:guestpw@mq.internal:5671/vhost", "guestpw"],
    ["https://tok_abcdef123456@sentry.example.io/1", "tok_abcdef123456"],
    ["Cookie: sid=abc123xyz; theme=dark; other=1", "abc123xyz"],
    ["Set-Cookie: session=s3ssion; Path=/; HttpOnly", "s3ssion"],
    ["GET /cb?code=AAA111BBB&state=zzz&page=2", "AAA111BBB"],
    ["https://bucket.s3.example/x?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIAxxxx", "deadbeefcafe"],
    ["jdbc:postgresql://db/x?user=app&password=jdbcpass1", "jdbcpass1"],
    ["conn host=10.0.3.4 user=app password=s3cr3tpw db=x", "s3cr3tpw"],
    ["client_secret=abcDEF123456 grant=x", "abcDEF123456"],
  ])("masks the secret in %s", (input, secret) => {
    expect(redactText(input)).not.toContain(secret);
  });

  it("keeps useful diagnostic meaning (scheme, host, port, database) in operator view", () => {
    expect(redactText("connect ECONNREFUSED postgres://app:Pw12345x@db.internal:5432/shop")).toBe("connect ECONNREFUSED postgres://[REDACTED]@db.internal:5432/shop");
  });

  it("is idempotent for all of the above", () => {
    for (const s of ["redis://:hunter2hunter2@cache:6379", "Cookie: a=b; c=d", "?code=AAA111&state=x", "password=abc12345 x", "Authorization: Bearer abcdef1234567890xyz"]) {
      const once = redactText(s);
      expect(redactText(once)).toBe(once);
    }
  });

  it("shareable mode pseudonymises hosts, IPs and home paths deterministically while keeping shape", () => {
    const p = new Pseudonymizer();
    const a = redactText("connect postgres://app:Pw12345x@db.internal:5432/shop then https://db.internal/health and cache.svc.cluster.local", { shareable: true, pseudo: p });
    expect(a).toBe("connect postgres://[REDACTED]@host-1:5432/shop then https://host-1/health and host-2");
    expect(redactText("peer 10.1.2.3 and 8.8.8.8 and 192.168.0.9", { shareable: true, pseudo: p })).toBe("peer [PRIVATE_IP] and [IP] and [PRIVATE_IP]");
    expect(redactText("at run (/home/alice/app/x.js:10:2) C:\\Users\\Bob\\x", { shareable: true })).toBe("at run (/home/[user]/app/x.js:10:2) C:\\Users\\[user]\\x");
    // same input → same pseudonym on a second call with the same pseudonymizer
    expect(redactText("https://db.internal/x", { shareable: true, pseudo: p })).toBe("https://host-1/x");
  });

  it("does not alter dashboard output when shareable is off (hosts stay visible)", () => {
    expect(redactText("https://api.example.com/x 10.0.0.1")).toBe("https://api.example.com/x 10.0.0.1");
  });

  it("scrubs embedded emails and tokens inside stack traces", () => {
    const trace = "Error: auth failed for bob@example.com token=abc123456789xyz\n    at connect (/home/bob/app/db.js:1:1)";
    const out = redactText(trace, { shareable: true });
    expect(out).not.toMatch(/bob@example|abc123456789xyz|\/home\/bob/);
  });
});

describe("integrity hashes (Phase 1D)", () => {
  const h = "a1b2c3d4".repeat(8);
  it("a 64-hex proposal digest / state fingerprint passes under exactly those keys", () => {
    expect(redactDeep({ proposal: { digest: h, stateFingerprint: h } })).toEqual({ proposal: { digest: h, stateFingerprint: h } });
  });
  it("the content digests shown in the live approval / offline preview pass under exactly their own keys (they used to reach the browser as [REDACTED])", () => {
    const doc = { artifact: { zipSha256: h, analysisDigest: h, artifactDigest: h }, cli: { argvDigest: h, manifestDigest: h, entrySha256: h } };
    expect(redactDeep(doc)).toEqual(doc);
    expect(JSON.stringify(redactDeep({ zipSha256: h.toUpperCase(), zip: h, sha: h }))).not.toContain(h);
    expect(JSON.stringify(redactDeep({ artifactDigest: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" }))).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
  it("the same value under any other key is still redacted", () => {
    const out = JSON.stringify(redactDeep({ token: h, note: h, fingerprint: h, other: { hash: h } }));
    expect(out).not.toContain(h);
  });
  it("a non-hash or uppercase value under those keys is scrubbed as usual", () => {
    expect(JSON.stringify(redactDeep({ digest: h.toUpperCase() }))).not.toContain(h.toUpperCase());
    expect(JSON.stringify(redactDeep({ digest: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" }))).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
