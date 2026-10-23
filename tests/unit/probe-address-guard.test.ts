import { describe, expect, it } from "vitest";
import { isBlockedAddress, makeGuardedLookup, parseIPv6 } from "@/server/live/probe";

const lookupErr = (ips: string[]) => new Promise<string | undefined>((res) => makeGuardedLookup(async () => ips)("h", { all: true }, (err) => res((err as { code?: string } | null)?.code)));

/** Every case below was a real bypass or gap in the previous prefix-string classifier, or a boundary of a reserved range. */
const BLOCKED_V6 = [
  "::", "::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001",
  "::a00:1", "::10.0.0.1", "::7f00:1", "::127.0.0.1", // IPv4-compatible (deprecated) → private/loopback IPv4
  "::ffff:10.0.0.1", "::ffff:a00:1", "0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:FFFF:7F00:1", "::FFFF:169.254.169.254", // IPv4-mapped, every notation
  "::ffff:0:a00:1", "::ffff:0:10.0.0.1", // SIIT
  "64:ff9b::a00:1", "64:ff9b::10.0.0.1", "64:ff9b:1::1", // NAT64
  "2002:a00:1::1", "2002:7f00:1::1", "2002:a9fe:a9fe::1", "2002::1", // 6to4 (embeds a private IPv4)
  "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:1::1", "2001:db8::1", "2001:DB8:0:0:0:0:0:1", // Teredo / IETF assignments / documentation
  "3ffe::1", "fec0::1", "fec0:0:0:1::1", "fc00::1", "fd00:ec2::254", "fe80::1", "febf::1", "ff02::1", "ff00::", // 6bone, site-local, ULA, link-local, multicast
  "100::1", "8000::1", "4000::1", "1::1", // outside 2000::/3
  "fe80::1%eth0", "fe80::1%25eth0", // zone id
];
const ALLOWED_V6 = ["2a01:4f8::1", "2606:4700:4700::1111", "2400:cb00::1", "2a00:1450:4001:81b::200e", "2001:4860:4860::8888", "2620:fe::fe", "2001:200::1", "2003::1", "2001:0200:0:0:0:0:0:1"];

const BLOCKED_V4 = [
  "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.255.255.254", "100.64.0.1", "100.100.100.200", "100.127.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255",
  "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
];
const ALLOWED_V4 = ["185.208.1.1", "8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.0.1.1", "192.88.98.1", "192.88.100.1", "198.17.255.255", "198.20.0.1", "223.255.255.255"];

describe("isBlockedAddress: IPv6 is an allowlist (global unicast 2000::/3 minus reserved/transition blocks) after a real parse", () => {
  it.each(BLOCKED_V6)("blocks %s", (ip) => expect(isBlockedAddress(ip), ip).toBe(true));
  it.each(ALLOWED_V6)("allows public %s", (ip) => expect(isBlockedAddress(ip), ip).toBe(false));
  it("IPv4-mapped public addresses follow the embedded IPv4 (allowed only when that IPv4 is public)", () => {
    expect(isBlockedAddress("::ffff:185.208.1.1")).toBe(false);
    expect(isBlockedAddress("::ffff:b9d0:101")).toBe(false);
    expect(isBlockedAddress("::ffff:192.168.1.1")).toBe(true);
  });
});

describe("isBlockedAddress: IPv4 reserved ranges and boundaries", () => {
  it.each(BLOCKED_V4)("blocks %s", (ip) => expect(isBlockedAddress(ip), ip).toBe(true));
  it.each(ALLOWED_V4)("allows public %s", (ip) => expect(isBlockedAddress(ip), ip).toBe(false));
});

describe("isBlockedAddress: anything that is not a valid IP literal is blocked (fail closed)", () => {
  it.each(["", " ", "example.com", "localhost", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.-4", "0x7f.0.0.1", "2130706433", "017700000001", "::g", "1:2:3:4:5:6:7:8:9", "1::2::3", ":::", "12345::1", "::1.2.3", "::256.1.1.1", "http://[::1]/"])("blocks %j", (ip) => expect(isBlockedAddress(ip), ip).toBe(true));
});

describe("parseIPv6", () => {
  it("parses every notation to the same 16 bytes", () => {
    const want = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 127, 0, 0, 1];
    for (const t of ["::ffff:7f00:1", "::FFFF:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:ffff:7f00:0001"]) expect(parseIPv6(t), t).toEqual(want);
    expect(parseIPv6("::")).toEqual(new Array(16).fill(0));
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
  });
  it("rejects malformed text", () => {
    for (const t of ["", "1::2::3", "1:2:3:4:5:6:7", "::g", "1:2:3:4:5:6:7:8:9", "fe80::1%eth0"]) expect(parseIPv6(t), t).toBeNull();
  });
});

describe("the guarded DNS lookup refuses a whole answer if ANY address is blocked (mixed answers, odd notations)", () => {
  it("mixed public + blocked in either order ⇒ ESSRF", async () => {
    expect(await lookupErr(["185.208.1.1", "::a00:1"])).toBe("ESSRF");
    expect(await lookupErr(["2002:7f00:1::1", "185.208.1.1"])).toBe("ESSRF");
    expect(await lookupErr(["2a01:4f8::1", "fec0::1"])).toBe("ESSRF");
    expect(await lookupErr(["185.208.1.1", "192.88.99.1"])).toBe("ESSRF");
  });
  it("only public v4 + v6 ⇒ accepted", async () => {
    expect(await lookupErr(["185.208.1.1", "2a01:4f8::1"])).toBeUndefined();
  });
  it("every audit address ⇒ ESSRF on its own", async () => {
    for (const ip of ["::a00:1", "::10.0.0.1", "2002:a00:1::1", "2002:7f00:1::1", "fec0::1", "::ffff:0:a00:1", "0:0:0:0:0:ffff:7f00:1", "192.88.99.1"]) expect(await lookupErr([ip]), ip).toBe("ESSRF");
  });
});
