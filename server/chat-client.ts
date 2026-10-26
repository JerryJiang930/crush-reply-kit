// Minimal OpenAI-compatible chat client. Deliberately tiny: one POST, one
// timeout, one shape. No SDK, no vendor lock, works identically against
// Ollama / LM Studio / vLLM / DeepSeek / DashScope.
import type { ChatConfig } from "./chat-config";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatResult = {
  text: string;
  model: string;
  usage?: { prompt?: number; completion?: number };
  latencyMs: number;
};

export class ChatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/**
 * Qwen3 and other reasoning models wrap their scratchpad in a thinking block.
 * The draft is meant to be pasted straight into a chat box, so anything before
 * the final closing tag is dropped. Two spellings exist in the wild: the plain
 * ` thinking…<｜end▁of▁thinking｜>` form and the special-token form. An unclosed opener means
 * the model ran out of tokens mid-thought → treat as empty so the caller falls
 * back to the structured suggestion.
 */
const THINK_CLOSERS = ["<｜end▁of▁thinking｜>", "<｜end▁of▁thinking｜>"];
/** An opener with no closer, after trimming, means the answer never started. */
const UNCLOSED_THINKING = /^(?:thinking\b|<\/?think\b|<｜begin▁of▁thinking｜>)/i;

export function stripReasoning(raw: string): string {
  let text = raw.trim();

  let cut = -1;
  for (const m of THINK_CLOSERS) {
    const i = text.lastIndexOf(m);
    if (i !== -1) cut = Math.max(cut, i + m.length);
  }
  if (cut !== -1) text = text.slice(cut).trim();
  else if (UNCLOSED_THINKING.test(text)) return "";

  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  }
  // Models sometimes wrap the sentence in quotes despite being told not to.
  text = text.replace(/^[“"「『](.*)[”"」』]$/s, "$1").trim();
  return text;
}

/** Ollama's native routes hang off the server root, not the /v1 prefix. */
function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

export async function chatComplete(
  cfg: ChatConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<ChatResult> {
  if (cfg.wire === "ollama") return ollamaChat(cfg, messages, fetchImpl);

  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw toChatError(err, cfg);
  }

  const body = await res.text();
  if (!res.ok) {
    throw new ChatError(
      `聊天模型返回 ${res.status}：${body.slice(0, 200)}`,
      res.status,
    );
  }

  let data: {
    model?: string;
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    data = JSON.parse(body);
  } catch {
    throw new ChatError("聊天模型返回的不是 JSON：" + body.slice(0, 120));
  }

  const raw = data.choices?.[0]?.message?.content ?? "";
  return {
    text: stripReasoning(raw),
    model: data.model ?? cfg.model,
    usage: data.usage
      ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens }
      : undefined,
    latencyMs: Date.now() - started,
  };
}

/**
 * Ollama's own /api/chat. Needed because the OpenAI-compatible route ignores
 * think:false, so a Qwen3 draft spends the budget thinking and returns an empty
 * string. Native: 14 tokens / 0.28s. Compatible route: 183 tokens / 4.5s.
 */
async function ollamaChat(
  cfg: ChatConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch,
): Promise<ChatResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(`${ollamaRoot(cfg.baseUrl)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: false,
        think: false,
        options: { temperature: cfg.temperature, num_predict: cfg.maxTokens },
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw toChatError(err, cfg);
  }

  const body = await res.text();
  if (!res.ok) {
    throw new ChatError(`聊天模型返回 ${res.status}：${body.slice(0, 200)}`, res.status);
  }

  let data: {
    model?: string;
    message?: { content?: string; thinking?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  try {
    data = JSON.parse(body);
  } catch {
    throw new ChatError("聊天模型返回的不是 JSON：" + body.slice(0, 120));
  }

  return {
    text: stripReasoning(data.message?.content ?? ""),
    model: data.model ?? cfg.model,
    usage: { prompt: data.prompt_eval_count, completion: data.eval_count },
    latencyMs: Date.now() - started,
  };
}

function toChatError(err: unknown, cfg: ChatConfig): ChatError {
  const e = err as { name?: string; cause?: { code?: string } };
  if (e.name === "TimeoutError") {
    return new ChatError(`聊天模型超时（${cfg.timeoutMs}ms）`);
  }
  return new ChatError(
    `连不上聊天模型 ${cfg.baseUrl}${e.cause?.code ? ` (${e.cause.code})` : ""}`,
  );
}

/** GET the model list — used by the probe script to prove the endpoint is alive. */
export async function listChatModels(
  cfg: ChatConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  if (cfg.wire === "ollama") {
    const res = await fetchImpl(`${ollamaRoot(cfg.baseUrl)}/api/tags`, {
      signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 15_000)),
    });
    if (!res.ok) throw new ChatError(`GET /api/tags 返回 ${res.status}`, res.status);
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
  }
  const res = await fetchImpl(`${cfg.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(Math.min(cfg.timeoutMs, 15_000)),
  });
  if (!res.ok) throw new ChatError(`GET /models 返回 ${res.status}`, res.status);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}
