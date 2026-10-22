import { afterAll } from "vitest";
import { __setLogSinkForTests } from "@/server/security/logger";
import { blockedAttempts, installNetworkGuard } from "./network-guard";

// Keep test output readable; individual tests that assert on logs install their own sink.
__setLogSinkForTests(() => undefined);

// Zero-cost guarantee: no test may touch the network (see tests/integration/zero-cost.test.ts).
installNetworkGuard();
afterAll(() => {
  if (blockedAttempts.length) throw new Error(`Unexpected network attempts: ${blockedAttempts.join(", ")}`);
});
