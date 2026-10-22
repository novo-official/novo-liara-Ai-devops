import type { AppConfig } from "../../config/env";
import { DisabledLiveLLMProvider } from "./disabled";
import { MockDiagnosticLLMProvider } from "./mock";
import type { DiagnosticLLMProvider } from "./provider";

export * from "./provider";
export { DisabledLiveLLMProvider, MockDiagnosticLLMProvider };
export type { MockBehavior } from "./mock";

/** Resolves the configured provider. There is no branch that can produce a live client. */
export function resolveProvider(cfg: Pick<AppConfig, "ai">): DiagnosticLLMProvider {
  if (cfg.ai.provider === "mock" && cfg.ai.liveRequestsEnabled === false) return new MockDiagnosticLLMProvider("ok");
  return new DisabledLiveLLMProvider();
}
