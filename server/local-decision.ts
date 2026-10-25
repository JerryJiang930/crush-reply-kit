// Gluecode between crush-monitor's System One request and a locally hosted
// decision model (Laya, AnyJev, or any server speaking the same shape).
//
// Contract (verified against server/provider.ts): whatever the backend, this
// must resolve to exactly:
//   { model: string, answers: Record<string, Answer>, usage }
//   Answer = {type:"noul", noul} | {type:"choice", choice, confidence, probabilities}
//          | {type:"score", score, confidence, probabilities}
//
// And validateResult() enforces these invariants:
//   1. every question id answered, with a matching type
//   2. probabilities keys === criteria keys exactly
//   3. sum(probabilities) ~= 1 within keys.length * 0.005 + 0.001
//   4. choice is one of the criteria keys
//   5. score <= criteria.length - 1
import type { Questions } from "@typesafe-ai/sdk";
import { ProviderError, validateResult } from "./provider";

export type LocalEngineConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
  /** Which wire translation to use. Everything else is generic. */
  dialect: "systemone" | "laya" | "anyjev";
};

type Raw = { state: unknown; questions: Questions; model?: string };

/**
 * Translate our request into whatever the local server speaks, then translate
 * its reply back into the strict answer shape. Dialects live here and nowhere
 * else - nothing downstream knows where the numbers came from.
 */
const dialects: Record<
  LocalEngineConfig["dialect"],
  {
    path: () => string;
    encode: (raw: Raw) => unknown;
    decode: (payload: unknown, questions: Questions, fallbackModel: string) => {
      model: string;
      answers: Record<string, unknown>;
      usage: { input_tokens: number; output_tokens: number };
    };
  }
> = {
  // Shape-compatible with TypeSafe's POST /v1/systemone minus the network hop.
  // This is what our own dev server and most compatible servers speak.
  systemone: {
    path: () => "/v1/systemone",
    encode: (raw) => ({ model: raw.model, state: raw.state, questions: raw.questions }),
    decode: (payload, _q, fallbackModel) => {
      const data = payload as {
        model?: string;
        answers?: Record<string, unknown>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (!data.answers) throw new ProviderError(502, "本地判断服务未返回 answers。");
      return {
        model: data.model || fallbackModel,
        answers: data.answers,
        usage: {
          input_tokens: data.usage?.input_tokens ?? 0,
          output_tokens: data.usage?.output_tokens ?? 0,
        },
      };
    },
  },
  // Laya exposes typed decisions natively (choice / score / noul). The
  // translation below assumes its HTTP server answers per-question; update
  // `path` and field names once you have verified your laya[serve] version.
  laya: {
    path: () => "/decide",
    encode: (raw) => ({
      model: raw.model,
      state: raw.state,
      questions: Object.entries(raw.questions).map(([id, q]) => ({ id, ...q })),
    }),
    decode: (payload, questions, fallbackModel) => {
      const data = payload as {
        model?: string;
        results?: Array<Record<string, unknown>>;
        decisions?: Array<Record<string, unknown>>;
      };
      const rows = data.results ?? data.decisions;
      if (!Array.isArray(rows))
        throw new ProviderError(502, "Laya 返回格式异常：缺少 decisions 数组。");
      const answers: Record<string, unknown> = {};
      for (const row of rows) {
        const id = String(row.id ?? row.question ?? "");
        const question = (questions as Record<string, { type?: string }>)[id];
        if (!id || !question) continue;
        answers[id] = normalizeLayaAnswer(row, question.type);
      }
      return {
        model: data.model || fallbackModel,
        answers,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  },
  // AnyJev wraps an open-weight LLM and returns calibration-corrected
  // distributions keyed by choice labels.
  anyjev: {
    path: () => "/decide",
    encode: (raw) => ({
      model: raw.model,
      state: raw.state,
      questions: raw.questions,
    }),
    decode: (payload, _questions, fallbackModel) => {
      const data = payload as {
        model?: string;
        answers?: Record<string, unknown>;
      };
      if (!data.answers) throw new ProviderError(502, "AnyJev 返回格式异常。");
      return {
        model: data.model || fallbackModel,
        answers: data.answers,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  },
};

function normalizeLayaAnswer(row: Record<string, unknown>, type?: string) {
  const probs = (row.probabilities ?? row.distribution ?? {}) as Record<string, number>;
  if (type === "noul") {
    const noul = typeof row.noul === "number" ? row.noul : (row.probability as number);
    if (typeof noul !== "number")
      throw new ProviderError(502, "Laya 的 noul 答案缺少概率值。");
    return { type: "noul" as const, noul: clamp01(noul) };
  }
  const weights = Object.keys(probs).length ? probs : undefined;
  if (type === "score") {
    const score = typeof row.score === "number" ? row.score : Number(row.value ?? 0);
    return {
      type: "score" as const,
      score,
      confidence: clamp01(Number(row.confidence ?? 0)),
      probabilities: weights ?? {},
    };
  }
  return {
    type: "choice" as const,
    choice: String(row.choice ?? row.label ?? ""),
    confidence: clamp01(Number(row.confidence ?? 0)),
    probabilities: weights ?? {},
  };
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export async function evaluateLocalDecision(
  raw: Raw,
  config: LocalEngineConfig,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
) {
  const dialect = dialects[config.dialect];
  if (!dialect)
    throw new ProviderError(500, `未知的本地判断方言：${config.dialect}`);
  // The incoming payload may not carry a model name; always let the configured
  // model win so the backend routes to the right checkpoint.
  const normRaw: Raw = { ...raw, model: raw.model || config.model };
  const deadline = AbortSignal.timeout(60_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const url = config.endpoint.replace(/\/+$/, "") + dialect.path();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(dialect.encode(normRaw)),
      signal: requestSignal,
    });
  } catch (error) {
    if (requestSignal.aborted) throw error;
    throw new ProviderError(
      502,
      `连不上本地判断服务 ${url}，请确认它已启动。 / Local decision server unreachable.`,
    );
  }
  if (!response.ok) {
    // Never echo provider bodies: they may contain chat text.
    await response.body?.cancel();
    throw new ProviderError(
      response.status === 401 ? 401 : 502,
      `本地判断服务返回 ${response.status}，请检查服务日志。 / Local decision server error.`,
    );
  }
  const payload = await response.json().catch(() => {
    throw new ProviderError(502, "本地判断服务返回了非 JSON 内容。");
  });
  // Same guard rail the hosted engines get: no fabricated distributions, and a
  // partially answered request is a failed request.
  return validateResult(
    dialect.decode(payload, normRaw.questions, normRaw.model ?? config.model),
    normRaw.questions,
  );
}
