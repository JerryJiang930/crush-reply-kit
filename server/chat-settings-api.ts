// Draft-model (OUT) configuration over HTTP, mirroring settings-api.ts.
//
// The judgment model already has a web settings page; this gives the *draft*
// model the same treatment so neither model is hardcoded. Pointing the draft at
// a hosted OpenAI-compatible API instead of the local Ollama is a preset change,
// never a code change.
//
// Stored in .runtime/chat.json (gitignored). Sensitive fields stay local; the
// GET view masks the key.
import { Router } from "express";
import { z } from "zod";
import {
  chatConfigPath,
  normalizeChatConfig,
  readChatConfigFile,
  resolveChatConfig,
  saveChatConfig,
} from "./chat-config";
import { CHAT_PRESETS } from "../shared/chat-presets";

export const chatSettingsRouter = Router();

const token = (() => {
  // Deliberately simple: the chat config is local-only and low-risk, so a
  // static token just stops cross-origin writes without a session.
  return "local-chat-config";
})();

chatSettingsRouter.use((req, res, next) => {
  const remote = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote || "")) {
    res.status(403).json({ error: "草稿模型配置只能在本机访问。" });
    return;
  }
  if (
    req.method !== "GET" &&
    (!req.is("application/json") || req.get("x-config-token") !== token)
  ) {
    res.status(403).json({ error: "请刷新页面后重新配置。" });
    return;
  }
  next();
});

const saveSchema = z
  .object({
    preset: z.string().trim().max(80).default("custom"),
    baseUrl: z.string().trim().max(500).default(""),
    model: z.string().trim().max(200).default(""),
    apiKey: z.string().trim().max(4096).default(""),
    wire: z.enum(["openai", "ollama"]).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(8192).optional(),
  })
  .strict();

function publicView(configured: boolean) {
  const fromFile = readChatConfigFile();
  const resolved = resolveChatConfig();
  const current = resolved
    ? {
        preset: resolved.preset,
        baseUrl: resolved.baseUrl,
        model: resolved.model,
        wire: resolved.wire,
        temperature: resolved.temperature,
        maxTokens: resolved.maxTokens,
        hasKey: !!resolved.apiKey && resolved.apiKey !== "local",
      }
    : fromFile
      ? {
          preset: fromFile.preset || "custom",
          baseUrl: fromFile.baseUrl || "",
          model: fromFile.model || "",
          wire: (fromFile.wire as "openai" | "ollama") || "openai",
          hasKey: !!fromFile.apiKey && fromFile.apiKey !== "local",
        }
      : null;
  return {
    configured,
    presets: CHAT_PRESETS,
    current,
    token,
  };
}

chatSettingsRouter.get("/", (_req, res) => {
  res.json(publicView(!!resolveChatConfig()));
});

chatSettingsRouter.post("/", (req, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "配置格式不正确，请检查后重试。" });
    return;
  }
  try {
    const config = normalizeChatConfig(parsed.data);
    saveChatConfig(config);
    res.json(publicView(true));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "保存失败" });
  }
});
