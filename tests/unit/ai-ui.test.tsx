import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiAttribution, AiRetry, ModelPending } from "@/components/ai-message";
import { AiProviderBadge } from "@/components/ai-provider-badge";
import { AgentWorkspace } from "@/components/agent-workspace";
import { DiagnosticReportView } from "@/components/diagnostic-report";
import { ai as aiText } from "@/i18n/agent-fa";
import { getAiStatus, recordAiCall, reserveRequest, __resetAiStatusForTests, type AiStatus } from "@/server/ai/status";
import { loadConfig } from "@/server/config/env";
import type { ConversationMessage } from "@/server/agent/types";
import { analyze } from "@/server/diagnostics/engine";
import { buildReport } from "@/server/diagnostics/report";
import { FAKE_KEY, MODEL } from "../helpers/boxapi";
import { ev, NOW, RUN } from "../helpers/evidence-builder";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const status = (over: Partial<AiStatus> = {}): AiStatus => ({ provider: "boxapi", enabled: true, configured: true, model: MODEL, missing: [], last: null, requestCount: 0, maxTotal: null, ...over });
const html = (n: React.ReactElement) => renderToStaticMarkup(n);
const msg = (over: Partial<ConversationMessage>): ConversationMessage => ({ id: "msg_1", conversationId: "conv_1", role: "agent", kind: "ai_answer", textFa: "متن", at: "2026-01-02T04:00:00.000Z", ...over });

describe("provider badge: configuration is not proof; the last request is", () => {
  it("renders nothing for mock / disabled", () => {
    expect(html(<AiProviderBadge ai={status({ provider: "mock", enabled: false, configured: false, model: null })} />)).toBe("");
  });
  it("configured, never called: says configured-only and 'no request yet'", () => {
    const out = html(<AiProviderBadge ai={status()} />);
    expect(out).toContain('data-testid="ai-provider-badge"');
    expect(out).toContain(MODEL);
    expect(out).toContain('data-configured="true"');
    expect(out).toContain(aiText.provider.configured);
    expect(out).toContain('data-ok="none"');
    expect(out).toContain(aiText.provider.lastNone);
  });
  it("incomplete configuration names what is missing (never a value) and is not marked configured", () => {
    const out = html(<AiProviderBadge ai={status({ configured: false, model: null, missing: ["api_key", "model"] })} />);
    expect(out).toContain('data-configured="false"');
    expect(out).toContain("BOXAPI_API_KEY");
    expect(out).toContain("BOXAPI_MODEL");
  });
  it("with a lifetime cap it shows requests sent / cap", () => {
    const out = html(<AiProviderBadge ai={status({ maxTotal: 1, requestCount: 0 })} />);
    expect(out).toContain('data-testid="ai-request-cap"');
    expect(html(<AiProviderBadge ai={status()} />)).not.toContain("ai-request-cap");
  });
  it("shows the last successful call with its token count, and a failed one as a failure", () => {
    const ok = html(<AiProviderBadge ai={status({ last: { at: "2026-01-02T04:00:00.000Z", ok: true, model: MODEL, error: null, httpStatus: 200, usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, durationMs: 900 } })} />);
    expect(ok).toContain('data-ok="true"');
    expect(ok).toContain(aiText.provider.lastOk);
    const bad = html(<AiProviderBadge ai={status({ last: { at: "2026-01-02T04:00:00.000Z", ok: false, model: MODEL, error: "insufficient_credit", httpStatus: 402, usage: null, durationMs: 300 } })} />);
    expect(bad).toContain('data-ok="false"');
    expect(bad).toContain(aiText.errors.insufficient_credit);
  });
  it("getAiStatus mirrors the config, records the last call, and never contains the key", () => {
    __resetAiStatusForTests();
    const cfg = loadConfig({ AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "true", BOXAPI_API_KEY: FAKE_KEY, BOXAPI_MODEL: MODEL });
    expect(getAiStatus(cfg)).toMatchObject({ enabled: true, configured: true, model: MODEL, last: null });
    reserveRequest(null);
    recordAiCall({ at: "2026-01-02T04:00:00.000Z", ok: true, model: MODEL, error: null, httpStatus: 200, usage: null, durationMs: 5 });
    expect(getAiStatus(cfg)).toMatchObject({ requestCount: 1, last: { ok: true } });
    expect(JSON.stringify(getAiStatus(cfg))).not.toContain(FAKE_KEY);
    expect(getAiStatus(loadConfig({}))).toMatchObject({ enabled: false, configured: false, model: null, last: null, requestCount: 0 }); // mock: nothing to report
    __resetAiStatusForTests();
  });
});

describe("agent workspace modes", () => {
  const ws = (provider: "mock" | "disabled" | "boxapi", ai?: AiStatus) => html(<AgentWorkspace apps={["demo-api"]} provider={provider} mode="mock" ai={ai} />);
  it("mock mode: unchanged — no badge, no 'ask the model' button, the old 'no real model' note", () => {
    const out = ws("mock");
    expect(out).not.toContain("ai-provider-badge");
    expect(out).not.toContain('data-testid="ask-model"');
    expect(out).toContain('data-provider="mock"');
  });
  it("BoxAPI mode, configured: badge + 'ask the model' button + the honest two-path explanation (and no claim that no model is used)", () => {
    const out = ws("boxapi", status());
    expect(out).toContain('data-testid="ai-provider-badge"');
    expect(out).toContain('data-testid="ask-model"');
    expect(out).toContain(aiText.provider.liveLimits);
    expect(out).not.toContain("مدل زبانی واقعی استفاده نمی‌شود");
    expect(out).toContain('data-provider="boxapi"');
  });
  it("BoxAPI mode, not configured: the setup state is visible and the ask button is absent (no request can be made)", () => {
    const out = ws("boxapi", status({ configured: false, model: null, missing: ["api_key"] }));
    expect(out).toContain('data-configured="false"');
    expect(out).not.toContain('data-testid="ask-model"');
  });
  it("the key never reaches the browser markup", () => {
    expect(ws("boxapi", status())).not.toContain(FAKE_KEY);
  });
});

describe("message pieces", () => {
  it("a model answer is attributed to BoxAPI with model + tokens and labelled as advice", () => {
    const out = html(<AiAttribution m={msg({ ai: { source: "boxapi", model: MODEL, usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } } })} />);
    expect(out).toContain('data-source="boxapi"');
    expect(out).toContain(aiText.answerNote);
    expect(out).toContain(MODEL);
    expect(out).toContain("3 توکن");
  });
  it("a cut-short answer says so", () => {
    expect(html(<AiAttribution m={msg({ ai: { source: "boxapi", model: MODEL, truncated: true } })} />)).toContain(aiText.truncatedNote);
    expect(html(<AiAttribution m={msg({ ai: { source: "boxapi", model: MODEL } })} />)).not.toContain(aiText.truncatedNote);
  });
  it("other message kinds get no AI attribution", () => {
    for (const kind of ["refusal", "report", "clarification"] as const) expect(html(<AiAttribution m={msg({ kind })} />)).toBe("");
  });
  it("a failed request offers an explicit retry only for ai_error with a question to resend", () => {
    expect(html(<AiRetry m={msg({ kind: "ai_error" })} question="سؤال" disabled={false} onRetry={() => undefined} />)).toContain('data-testid="ai-retry"');
    expect(html(<AiRetry m={msg({ kind: "ai_error" })} question="" disabled={false} onRetry={() => undefined} />)).toBe("");
    expect(html(<AiRetry m={msg({ kind: "ai_answer" })} question="سؤال" disabled={false} onRetry={() => undefined} />)).toBe("");
    expect(html(<AiRetry m={msg({ kind: "ai_error", ai: { source: "boxapi", error: "request_cap_reached" } })} question="سؤال" disabled={false} onRetry={() => undefined} />)).toBe(""); // retry cannot succeed after the lifetime cap
  });
  it("the loading state is announced and says the answer arrives whole (no fake streaming)", () => {
    const out = html(<ol><ModelPending /></ol>);
    expect(out).toContain('role="status"');
    expect(out).toContain(aiText.modelTyping);
    expect(aiText.modelTyping).toContain("بدون جریان زنده");
  });
  it("every error code has a Persian recovery text", () => {
    for (const code of ["not_configured", "unauthorized", "insufficient_credit", "rate_limited", "timeout", "model_unavailable", "too_large", "invalid_output", "cancelled", "provider_error", "provider_disabled", "output_truncated", "request_cap_reached"]) expect(aiText.errors[code], code).toBeTruthy();
  });
});

describe("diagnostic report narrative attribution", () => {
  const rep = (narrative: Parameters<typeof buildReport>[0]["narrative"]) => {
    const evidence = ev({ logs: [{ ago: 5, msg: "x" }] });
    return html(<DiagnosticReportView report={buildReport({ runId: RUN, app: "demo-app", intent: "why_restarting", evidence, analysis: analyze({ runId: RUN, intent: "why_restarting", evidence, semantics: {}, now: NOW }), narrative, now: NOW })} />);
  };
  it("a real-model narrative says BoxAPI wrote it (model, tokens) and that the findings are the deterministic part", () => {
    const out = rep({ status: "ok", source: "boxapi", textFa: "متن مدل", citedEvidenceIds: [], model: MODEL, usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } });
    expect(out).toContain('data-testid="narrative-attribution"');
    expect(out).toContain('data-source="boxapi"');
    expect(out).toContain(MODEL);
    expect(out).not.toContain("نه یک مدل واقعی");
  });
  it("a failed real-model narrative shows the failure and says nothing was substituted", () => {
    const out = rep({ status: "error", source: "boxapi", citedEvidenceIds: [], failure: "insufficient_credit" });
    expect(out).toContain(aiText.errors.insufficient_credit);
    expect(out).toContain("چیزی جایگزین نشده");
    expect(out).not.toContain("blockquote");
  });
});
