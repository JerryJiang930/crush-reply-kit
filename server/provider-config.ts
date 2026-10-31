export const PROVIDERS = {
  typesafe: {
    name: "TypeSafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-1.13.0",
    keyEnv: "TYPESAFE_API_KEY",
    keyUrl: "https://console.typesafe.ai/",
  },
  vercel: {
    name: "Vercel AI Gateway",
    endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    model: "typesafe-ai/jev",
    keyEnv: "AI_GATEWAY_API_KEY",
    keyUrl: "https://vercel.com/d?to=/%5Bteam%5D/~/ai-gateway/api-keys",
  },
  openrouter: {
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/alpha/decisions",
    model: "typesafe/jev-1.13",
    keyEnv: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
  opencode: {
    name: "OpenCode Jev（限时免费）",
    // Zen 网关，不是 /inference/。免费的 jev-1.13-free 和付费的 jev-1.13 同一个端点。
    endpoint: "https://opencode.ai/zen/v1/systemone",
    model: "jev-1.13-free",
    keyEnv: "OPENCODE_API_KEY",
    keyUrl: "https://opencode.ai/auth",
  },
} as const;
export type Provider = keyof typeof PROVIDERS;
/**
 * 运行时的判别服务配置。字段用 string 而不是 PROVIDERS 的字面量：
 * endpoint 要能被覆盖（测试指向本机 stub，用户指向自建网关），
 * model 也是同理。
 */
export type ProviderConfig = {
  provider: Provider;
  name: string;
  endpoint: string;
  model: string;
  keyEnv: string;
  keyUrl: string;
  apiKey: string;
};

export class ConfigurationError extends Error {
  readonly status = 503;
}

export function getProviderConfig(
  env: Record<string, string | undefined> = process.env,
): ProviderConfig {
  const selected = env.JEV_PROVIDER?.trim().toLowerCase() || "typesafe";
  if (!Object.hasOwn(PROVIDERS, selected))
    throw new ConfigurationError(
      `平台只支持 ${Object.keys(PROVIDERS).join("、")}。请运行 npm run setup。 / Unsupported provider.`,
    );
  const provider = selected as Provider;
  const preset = PROVIDERS[provider];
  const apiKey = (env.JEV_API_KEY || env[preset.keyEnv] || "").trim();
  if (!apiKey || /^(your[_-].*|replace[_-].*|xxx+|<.*>)$/i.test(apiKey))
    throw new ConfigurationError(
      `${preset.name} 未配置 API Key，请运行 npm run setup。 / API key required.`,
    );
  if (/[\s\x00-\x1f\x7f"'`]/.test(apiKey) || apiKey.includes("="))
    throw new ConfigurationError(
      "请只粘贴 Key 本身，不要带变量名、引号或 Bearer。 / Paste the key only.",
    );
  if (apiKey.startsWith("sk-or-") && provider !== "openrouter")
    throw new ConfigurationError(
      "这看起来是 OpenRouter Key，请选择 openrouter。 / Select OpenRouter for this key.",
    );
  return { ...preset, provider, apiKey };
}

export function providerStatus(
  env: Record<string, string | undefined> = process.env,
) {
  try {
    const config = getProviderConfig(env);
    return { configured: true, provider: config.provider, model: config.model };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return { configured: false, error: error.message };
  }
}
