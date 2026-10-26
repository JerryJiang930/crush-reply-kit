// replysmith run entrypoint: IN -> THINK -> OUT, end to end.
//
//   npx tsx scripts/run.ts
//
// Everything is driven by environment variables so nothing is hardcoded. The
// default source is a sample JSON file, the default decision engine is a local
// service on 8421, and the default deliver mode is "print" so nothing touches
// your clipboard unless you opt in with DELIVER_MODE=clipboard.
//
// Real WeChat ingestion is OFF by default. Set SOURCE=wechat plus WECHAT_DB_DIR
// (the decrypted/ directory produced by 328336690/wechat-decrypt) and
// ALLOWED_PEERS to enable it. That tool must be run by you, with admin rights:
// it extracts keys from the running WeChat process and decrypts the SQLCipher
// databases. This repo only reads its output, and only for peers who consented.
//
// The pipeline is exported as runOnce() so scripts/up.ts can boot the local
// services and then call it in-process, the same way upstream's start.ts simply
// imports server/index and lets it run.
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { runPipeline, type SessionReport } from "../server/pipeline";
import { createManualSource, createWeChatSource } from "../shared/sources";
import type { LocalConfig } from "../server/model-config";
import { describeChatConfig, resolveChatConfig } from "../server/chat-config";
import { copyToClipboard } from "../server/deliver";
import { renderCandidates, renderReport } from "../server/report";

function env(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

const DIALECTS = ["systemone", "laya", "anyjev"] as const;
type Dialect = (typeof DIALECTS)[number];

function decisionConfig(): LocalConfig {
  const raw = env("LOCAL_DIALECT", "systemone") as Dialect;
  const dialect = DIALECTS.includes(raw) ? raw : "systemone";
  // LOCAL_PORT drives both the launcher and this default, so changing the port
  // in one place cannot leave the request pointing at the old one.
  const port = env("LOCAL_PORT", "8421");
  return {
    engine: "local",
    provider: "local",
    name: "本地判断服务",
    endpoint: env("LOCAL_ENDPOINT") || `http://127.0.0.1:${port}`,
    model: env("LOCAL_MODEL", "convaiinnovations/laya-multilingual"),
    apiKey: env("LOCAL_API_KEY", "local"),
    protocol: "local",
    dialect,
  };
}

/**
 * Ask which candidate to copy. Returns the index, or null to skip.
 *
 * Non-interactive runs (pipes, CI) always take the first drafted candidate:
 * waiting on stdin there would hang until the timeout.
 */
async function choose(
  report: SessionReport,
  ask: (question: string) => Promise<string>,
): Promise<number | null> {
  const usable = report.candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.text);
  if (!usable.length) return null;
  if (!process.stdin.isTTY) return usable[0].i;

  const hint = usable.map(({ c, i }) => `${i + 1}）${c.label}`).join("　");
  const answer = (await ask(`复制哪一条？${hint}　回车=1，s=跳过：`)).trim().toLowerCase();
  if (answer === "s" || answer === "skip") return null;
  if (!answer) return usable[0].i;
  const n = Number(answer);
  return usable.some(({ i }) => i === n - 1) ? n - 1 : usable[0].i;
}

/** One full IN -> THINK -> OUT pass. Returns the per-session reports. */
export async function runOnce(): Promise<SessionReport[]> {
  const deliverMode =
    env("DELIVER_MODE", "print") === "clipboard" ? "clipboard" : "print";

  const sourceKind = env("SOURCE", "manual");
  const allowedPeers = env("ALLOWED_PEERS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const draft = resolveChatConfig();

  // "wechat-decrypt" 是旧名字，保留兼容；两者都指向同一个读库适配器。
  const wantsWeChat = sourceKind === "wechat" || sourceKind === "wechat-decrypt";
  const source = wantsWeChat
    ? createWeChatSource({
        kind: "wechat",
        dbDir: env("WECHAT_DB_DIR", ""),
        mappingFile: env("WECHAT_MAPPING", ".runtime/wechat-mapping.json"),
        allowedPeers,
      })
    : createManualSource({
        kind: "manual",
        file: env("SESSIONS_FILE", "examples/sample-sessions.json"),
        allowedPeers,
      });

  if (wantsWeChat && allowedPeers.length === 0) {
    console.error(
      "[replysmith] 伦理红线：开启微信读取前必须设置 ALLOWED_PEERS，只处理你已登记的会话。已退出。",
    );
    process.exitCode = 2;
    return [];
  }
  if (wantsWeChat && !env("WECHAT_DB_DIR")) {
    console.error(
      "[replysmith] 需要 WECHAT_DB_DIR 指向 wechat-decrypt 的 decrypted/ 目录。已退出。",
    );
    process.exitCode = 2;
    return [];
  }

  const sinceMs = env("SINCE_MS") ? Number(env("SINCE_MS")) : 0;
  if (draft) console.log(describeChatConfig(draft));
  else console.log("[chat] 没配聊天模型，只给方向和理由，不写句子");

  const reports = await runPipeline({
    source,
    decisionConfig: decisionConfig(),
    sinceMs,
    draft: draft ?? undefined,
    lineWindow: Number(env("LINE_WINDOW", "12")),
    candidates: Number(env("DRAFT_CANDIDATES", "3")),
    relation: (env("RELATION", "crush") as "crush" | "new" | "couple") ?? "crush",
  });

  const rl =
    deliverMode === "clipboard" && process.stdin.isTTY
      ? createInterface({ input: process.stdin, output: process.stdout })
      : null;
  try {
    for (const report of reports) {
      console.log(renderReport(report));
      if (report.candidates.length) console.log(renderCandidates(report.candidates));
      console.log("");

      if (deliverMode !== "clipboard") continue;
      const picked = await choose(
        report,
        rl
          ? (q) => rl.question(q)
          : async () => "",
      );
      if (picked === null) {
        console.log(`[replysmith] ${report.peer}：跳过了，没有复制。`);
        continue;
      }
      const text = report.candidates[picked].text!;
      await copyToClipboard(text);
      console.log(`[replysmith] ${report.peer}：第 ${picked + 1} 条已进剪贴板。`);
    }
  } finally {
    rl?.close();
  }

  console.log(`[replysmith] 处理完成：${reports.length} 个会话`);
  return reports;
}

// Only run when invoked directly, so importing this file (up.ts) has no effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOnce().catch((err) => {
    console.error(
      "[replysmith] 运行失败：",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
