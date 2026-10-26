// Chat-model presets for the OUT-side draft step (turning a chosen strategy
// into an actual sentence). This is deliberately separate from
// MODEL_PRESETS: those describe *judgment* engines (Jev / System One / local
// decision services), while these describe ordinary OpenAI-compatible chat
// completions endpoints.
//
// Local runtimes and hosted APIs are the same shape on purpose. Ollama,
// LM Studio, vLLM, DeepSeek and DashScope all speak /v1/chat/completions, so
// moving from a local GPU to a hosted API is a preset change, not a code
// change.
export const CHAT_PRESETS = [
  {
    id: "ollama",
    name: "Ollama · 本机",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3:8b",
    keyRequired: false,
    keyUrl: "",
    // Ollama's OpenAI-compatible route silently ignores think:false, so a
    // thinking model burns the whole token budget on its scratchpad and
    // returns nothing. Its native route honours it (measured here: 4.5s → 0.28s).
    wire: "ollama",
  },
  {
    id: "lmstudio",
    name: "LM Studio · 本机",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "",
    keyRequired: false,
    keyUrl: "",
    wire: "openai",
  },
  {
    id: "vllm",
    name: "vLLM · 本机 / 局域网",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "",
    keyRequired: false,
    keyUrl: "",
    wire: "openai",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keyRequired: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    wire: "openai",
  },
  {
    id: "dashscope",
    name: "通义千问 · 百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-8b",
    keyRequired: true,
    keyUrl: "https://bailian.console.aliyun.com/",
    wire: "openai",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-8B",
    keyRequired: true,
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    wire: "openai",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    keyRequired: true,
    keyUrl: "https://platform.openai.com/api-keys",
    wire: "openai",
  },
  {
    id: "custom",
    name: "其他 OpenAI 兼容服务",
    baseUrl: "",
    model: "",
    keyRequired: true,
    keyUrl: "",
    wire: "openai",
  },
] as const;

export type ChatPresetId = (typeof CHAT_PRESETS)[number]["id"];
/** Which HTTP shape the endpoint actually speaks. */
export type ChatWire = "openai" | "ollama";

export function findChatPreset(id: string) {
  return CHAT_PRESETS.find((p) => p.id === id);
}
