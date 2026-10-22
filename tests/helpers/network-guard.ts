import net from "node:net";
import tls from "node:tls";

/**
 * Zero-cost guarantee, enforced in every unit/integration test:
 * ANY use of the global fetch or a raw socket throws. Tests that need upstream behaviour inject their own
 * `fetchImpl`; nothing in the suite can reach a paid AI endpoint (or any other host) by accident.
 */
export const blockedAttempts: string[] = [];

const original = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, tlsConnect: tls.connect };

export function installNetworkGuard(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const target = input instanceof Request ? input.url : String(input);
    blockedAttempts.push(target);
    throw new Error(`NETWORK BLOCKED IN TESTS: ${target.split("?")[0]}`);
  }) as typeof fetch;
  net.Socket.prototype.connect = function blocked(this: net.Socket, ...args: unknown[]) {
    blockedAttempts.push(`socket:${JSON.stringify(args[0]).slice(0, 80)}`);
    throw new Error("SOCKET BLOCKED IN TESTS");
  } as typeof net.Socket.prototype.connect;
  tls.connect = (() => {
    blockedAttempts.push("tls");
    throw new Error("TLS BLOCKED IN TESTS");
  }) as typeof tls.connect;
}

export function uninstallNetworkGuard(): void {
  globalThis.fetch = original.fetch;
  net.Socket.prototype.connect = original.connect;
  tls.connect = original.tlsConnect;
}
