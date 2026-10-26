// replysmith run entrypoint: IN -> THINK -> OUT, end to end.
//
//   npx tsx scripts/run.ts
//
// Everything is driven by environment variables so nothing is hardcoded. Defaults
// point at the local Laya decision service and a sample session file, and the
// deliver step defaults to "print" so nothing touches your clipboard unless you
// opt in. To actually copy to clipboard, set DELIVER_MODE=clipboard.
//
// Real WeChat ingestion is OFF by default. Set SOURCE=wechat-decrypt and
// WECHAT_DECRYPT_URL to enable it — requires you to run 328336690/wechat-decrypt
// yourself with admin rights, and to set ALLOWED_PEERS to the peers you may
// process. Do not run it against peers who have not consented.
import { runPipeline } from "../server/pipeline";
import {
  createManualSource,
  createWeChatDecryptSource,
} from "../shared/sources";
import type { LocalConfig } from "../server/model-config";
import { describeChatConfig, resolveChatConfig } from "../server/chat-config";

function env(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

const decisionConfig: LocalConfig = {
  engine: "local",
  provider: env("LOCAL_PROVIDER", "laya"),
  name: "Local decision engine",
  endpoint: env("LOCAL_ENDPOINT", "http://127.0.0.1:8421"),
  model: env("LOCAL_MODEL", "convaiinnovations/laya-multilingual"),
  apiKey: env("LOCAL_API_KEY", "local"),
  protocol: "local",
  dialect: "systemone",
};

const deliverConfig = { mode: (env("DELIVER_MODE", "print") === "clipboard" ? "clipboard" : "print") as "clipboard" | "print" };

const sourceKind = env("SOURCE", "manual");
const allowedPeers = env("ALLOWED_PEERS").split(",").map((s) => s.trim()).filter(Boolean);

const draft = resolveChatConfig();

async function main() {
  const source =
    sourceKind === "wechat-decrypt"
      ? createWeChatDecryptSource({
          kind: "wechat-decrypt",
          baseUrl: env("WECHAT_DECRYPT_URL", "http://127.0.0.1:8000"),
          allowedPeers,
        })
      : createManualSource({
          kind: "manual",
          file: env("SESSIONS_FILE", "examples/sample-sessions.json"),
          allowedPeers,
        });

  if (sourceKind === "wechat-decrypt" && allowedPeers.length === 0) {
    console.error(
      "[replysmith] 伦理红线：开启微信抓取前必须设置 ALLOWED_PEERS，只处理你已登记的会话。已退出。",
    );
    process.exit(2);
  }

  const sinceMs = env("SINCE_MS") ? Number(env("SINCE_MS")) : 0;
  if (draft) console.log(describeChatConfig(draft));
  else console.log("[chat] 未配置聊天模型，OUT 将给出结构化建议（策略 + 理由）");

  const results = await runPipeline({
    source,
    decisionConfig,
    deliverConfig,
    sinceMs,
    draft: draft ?? undefined,
    relation: (env("RELATION", "crush") as "crush" | "new" | "couple") ?? "crush",
  });

  for (const r of results) {
    console.log(`\n=== ${r.peer} === action=${r.action} drafted=${r.drafted} delivered=${r.delivered}`);
    console.log(`策略：${r.strategy}`);
    console.log(r.text);
  }
  console.log(`\n[replysmith] 处理完成：${results.length} 个会话`);
}

main().catch((err) => {
  console.error("[replysmith] 运行失败：", err instanceof Error ? err.message : err);
  process.exit(1);
});
