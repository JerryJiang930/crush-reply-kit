// The web's one entry point into the whole pipeline.
//
// The browser posts a *source descriptor* (a pasted conversation, a JSON file,
// or a decrypted WeChat directory) plus a mode, and gets back a SessionReport
// per peer. This is the single source of truth both renderers (terminal and
// web) now draw from — the terminal path in scripts/run.ts calls runPipeline
// directly and is no longer a separate code path.
//
// Cold start: the first time a WeChat peer is analyzed we read the FULL history
// (sinceMs = 0) and call it the baseline. After that, "update" only pulls
// messages newer than the last one we saw, and the baseline cursor is advanced.
// The cursor lives in .runtime/peers/<peer>.json so reopening the page resumes
// incrementally instead of re-reading everything.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runPipeline } from "./pipeline";
import { activeConfig } from "./model-config";
import { ConfigurationError } from "./provider-config";
import { resolveChatConfig } from "./chat-config";
import { readPeerState, summaryStore, writePeerState } from "./peer-state";
import {
  createManualSource,
  createWeChatSource,
  type SourceAdapter,
} from "../shared/sources";
import type { Message, Relation } from "../shared/types";
import type { SessionReport } from "../shared/pipeline-types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const peersDir = resolve(repoRoot, ".runtime", "peers");

const messageSchema = z.object({
  id: z.string().optional(),
  sender: z.enum(["self", "other"]),
  text: z.string(),
  timestamp: z.union([z.string(), z.null()]).optional(),
  kind: z.enum(["text", "unreadable"]).optional(),
});

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline"), messages: z.array(messageSchema) }),
  z.object({ kind: z.literal("manual"), file: z.string().max(600) }),
  z.object({
    kind: z.literal("wechat"),
    dbDir: z.string().max(600),
    peer: z.string().max(200),
  }),
]);

const profileSchema = z
  .object({
    age: z.string().trim().max(20).optional(),
    role: z.string().trim().max(120).optional(),
    note: z.string().trim().max(400).optional(),
  })
  .strict();

export const pipelineRequestSchema = z.object({
  source: sourceSchema,
  relation: z.enum(["crush", "new", "couple"]).default("crush"),
  mode: z.enum(["baseline", "update"]).default("baseline"),
  profile: profileSchema.optional(),
  lineWindow: z.number().int().min(0).max(200).default(12),
  draftContext: z.number().int().min(4).max(200).optional(),
  messageWindow: z.number().int().min(0).max(4000).default(0),
});

export type PipelineRequest = z.infer<typeof pipelineRequestSchema>;

function normalizeInline(raw: unknown[]): Message[] {
  return raw.map((m, i) => {
    const msg = m as Record<string, unknown>;
    return {
      id: typeof msg.id === "string" && msg.id ? msg.id : `m${i}`,
      sender: msg.sender === "self" || msg.sender === "other" ? msg.sender : "other",
      text: typeof msg.text === "string" ? msg.text : String(msg.text ?? ""),
      timestamp: typeof msg.timestamp === "string" ? msg.timestamp : null,
      kind: msg.kind === "unreadable" ? "unreadable" : "text",
    };
  });
}

function buildAdapter(req: PipelineRequest): SourceAdapter {
  const s = req.source;
  if (s.kind === "inline") {
    const messages = normalizeInline(s.messages);
    return {
      id: "inline",
      async pull() {
        return [{ peer: "当前对话", messages }];
      },
    };
  }
  if (s.kind === "manual") {
    return createManualSource({ kind: "manual", file: s.file, allowedPeers: [] });
  }
  // wechat：只读白名单里那一个人，空白名单一律拒绝（伦理红线，不靠调用方自觉）
  if (!s.peer) throw new ConfigurationError("读微信库必须指定分析对象（peer）。");
  return createWeChatSource({
    kind: "wechat",
    dbDir: s.dbDir,
    allowedPeers: [s.peer],
  });
}


/** 库里的时间可能是秒也可能是毫秒，统一成毫秒再比大小。 */
function toMs(timestamp: unknown): number {
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

/**
 * Runs the full pipeline for one web request.
 *
 * Throws ConfigurationError (caught by the route → 503) when no judge model is
 * configured. The draft model is optional; when absent, candidates carry
 * strategy only and no sentences are written.
 */
export async function runPipelineApi(
  req: PipelineRequest,
  signal?: AbortSignal,
): Promise<SessionReport[]> {
  // 先确认判断模型已配置；没配就早点失败，不要跑到一半才报。
  activeConfig();

  const draft = resolveChatConfig() ?? undefined;
  const adapter = buildAdapter(req);

  let sinceMs = 0;
  if (req.mode === "update" && req.source.kind === "wechat") {
    const prev = readPeerState(req.source.peer);
    if (prev && prev.lastMs > 0) sinceMs = prev.lastMs + 1;
  }

  const reports = await runPipeline({
    source: adapter,
    decisionConfig: activeConfig(),
    draft,
    relation: req.relation as Relation,
    profile: req.profile,
    lineWindow: req.lineWindow,
    draftContext: req.draftContext ?? (Number(process.env.DRAFT_CONTEXT) || 30),
    peerSummary: summaryStore,
    messageWindow: req.messageWindow,
    sinceMs,
    candidates: 3,
    onDraftError: (peer, action, message) =>
      console.warn(`[replysmith] ${peer} 的「${action}」没写出来：${message}`),
  });

  // 推进 WeChat 基线游标：取每个报告里最晚一条消息的时间。
  for (const r of reports) {
    if (req.source.kind !== "wechat" || !r.peerId) continue;
    const lastMs = r.messages.reduce((max, m) => Math.max(max, toMs(m.timestamp)), 0);
    if (lastMs > 0)
      writePeerState(r.peerId, {
        lastMs,
        count: r.messages.length,
        name: r.peer,
      });
  }

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return reports;
}
