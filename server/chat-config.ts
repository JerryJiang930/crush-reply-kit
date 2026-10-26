// Resolves the chat-model configuration for the draft step. Two sources, in
// order of precedence:
//   1. explicit environment variables (CI, one-off runs)
//   2. a JSON file (default .runtime/chat.json, override with CHAT_CONFIG_PATH)
//
// Nothing about a specific vendor is baked in: a preset only supplies defaults
// for baseUrl/model, and every field can be overridden. Pointing this at a
// hosted API instead of the local Ollama takes three env vars and no code.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { CHAT_PRESETS, findChatPreset, type ChatWire } from "../shared/chat-presets";

export type ChatConfig = {
  /** OpenAI-compatible base URL, without the /chat/completions suffix. */
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** Which preset produced these defaults; "custom" when hand-written. */
  preset: string;
  /** HTTP shape: standard OpenAI, or Ollama's native route. */
  wire: ChatWire;
};

export const chatConfigPath = resolve(
  process.env.CHAT_CONFIG_PATH || ".runtime/chat.json",
);

const schema = z
  .object({
    preset: z.string().trim().max(80).default("custom"),
    baseUrl: z.string().trim().max(500).default(""),
    model: z.string().trim().max(200).default(""),
    apiKey: z.string().trim().max(4096).default(""),
    temperature: z.number().min(0).max(2).default(0.7),
    // Thinking models can spend the whole budget on their scratchpad before
    // writing a single visible token, so the ceiling has to leave room for both.
    maxTokens: z.number().int().min(1).max(8192).default(700),
    timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
    wire: z.enum(["openai", "ollama"]).optional(),
  })
  .strict();

type RawChatSettings = z.infer<typeof schema>;

/** Fills blanks from the preset, then validates the result. Throws on bad input. */
export function normalizeChatConfig(raw: Partial<RawChatSettings>): ChatConfig {
  const parsed = schema.parse({
    preset: "custom",
    ...raw,
    // Keep numbers honest when they arrive as strings from env.
    temperature: num(raw.temperature),
    maxTokens: num(raw.maxTokens),
    timeoutMs: num(raw.timeoutMs),
  });
  const preset = findChatPreset(parsed.preset);
  const baseUrl = parsed.baseUrl || preset?.baseUrl || "";
  const model = parsed.model || preset?.model || "";

  if (!baseUrl) throw new Error("聊天模型缺少 baseUrl（或选一个 preset）。");
  if (!model) throw new Error("聊天模型缺少 model 名称。");

  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`聊天模型 baseUrl 不是合法地址：${baseUrl}`);
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback)) {
    throw new Error("远端聊天模型必须用 HTTPS；本机地址才允许 HTTP。");
  }
  // A local runtime never needs a key. Only enforce it when the request is
  // actually leaving the machine, so a loopback proxy in front of a hosted
  // service is still allowed to be keyless.
  if (preset?.keyRequired && !isLoopback && !parsed.apiKey) {
    throw new Error(`preset「${preset.name}」需要 API Key。`);
  }

  return {
    preset: parsed.preset,
    baseUrl: baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, ""),
    model,
    // Local runtimes ignore the header but some clients require it non-empty.
    apiKey: parsed.apiKey || "local",
    temperature: parsed.temperature,
    maxTokens: parsed.maxTokens,
    timeoutMs: parsed.timeoutMs,
    wire: parsed.wire ?? preset?.wire ?? "openai",
  };
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function readChatConfigFile(file = chatConfigPath): Partial<RawChatSettings> | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<RawChatSettings>;
  } catch {
    throw new Error(`聊天模型配置无法读取：${file}`);
  }
}

function env(key: string): string {
  return (process.env[key] ?? "").trim();
}

/**
 * Returns null when nothing is configured — the pipeline then falls back to the
 * structured recommendation, which needs no chat model at all.
 */
export function resolveChatConfig(
  file = chatConfigPath,
): ChatConfig | null {
  const fromFile = readChatConfigFile(file);
  const fromEnv: Partial<RawChatSettings> = {};
  if (env("DRAFT_PRESET")) fromEnv.preset = env("DRAFT_PRESET");
  if (env("DRAFT_ENDPOINT")) fromEnv.baseUrl = env("DRAFT_ENDPOINT");
  if (env("DRAFT_MODEL")) fromEnv.model = env("DRAFT_MODEL");
  if (env("DRAFT_API_KEY")) fromEnv.apiKey = env("DRAFT_API_KEY");
  if (env("DRAFT_TEMPERATURE")) fromEnv.temperature = num(env("DRAFT_TEMPERATURE"));
  if (env("DRAFT_MAX_TOKENS")) fromEnv.maxTokens = num(env("DRAFT_MAX_TOKENS"));
  if (env("DRAFT_TIMEOUT_MS")) fromEnv.timeoutMs = num(env("DRAFT_TIMEOUT_MS"));
  if (env("DRAFT_WIRE")) fromEnv.wire = env("DRAFT_WIRE") as ChatWire;

  const hasEnv = Object.keys(fromEnv).length > 0;
  if (!hasEnv && !fromFile) return null;

  // Per-field merge: env wins, file fills the rest, preset fills the remainder.
  return normalizeChatConfig({ ...(fromFile ?? {}), ...fromEnv });
}

/** Human-readable one-liner for logs; never prints the key. */
export function describeChatConfig(c: ChatConfig): string {
  return `[chat] preset=${c.preset} wire=${c.wire} model=${c.model} base=${c.baseUrl} temp=${c.temperature} maxTokens=${c.maxTokens}`;
}

export { CHAT_PRESETS };
