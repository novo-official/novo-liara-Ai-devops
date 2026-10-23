import { BoxApiLLMProvider, type BoxApiOptions } from "@/server/ai/boxapi";
import { Secret } from "@/server/security/secret";

/** A recognisable fake key: tests assert it never appears anywhere except the Authorization header the mock receives. */
export const FAKE_KEY = "box-ai-FAKEKEY0000000000000000000000000000000000000000";
export const MODEL = "test-model-cheap";

export interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}
export const reply = (status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
export const completion = (text: string, extra: Record<string, unknown> = {}) => reply(200, { id: "x", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 }, ...extra });

/** A fetch double that records every request and answers with `respond` (default: a short Persian completion). It is the ONLY way these tests reach "BoxAPI". */
export function fakeFetch(respond: (call: Call, n: number) => Response | Promise<Response> = () => completion("پاسخ آزمایشی مدل")) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")), headers };
    calls.push(call);
    return respond(call, calls.length);
  }) as typeof fetch;
  return { impl, calls };
}

export function provider(over: Partial<BoxApiOptions> = {}) {
  const f = fakeFetch();
  const p = new BoxApiLLMProvider({ baseUrl: "https://ai.boxapi.ir/ai/v1", model: MODEL, apiKey: new Secret(FAKE_KEY), maxOutputTokens: 600, timeoutMs: 5000, fetchImpl: f.impl, ...over });
  return { p, f };
}
