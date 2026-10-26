// Probe the configured chat model end to end. Use this first whenever you
// point replysmith at a new endpoint — it tells you whether the failure is the
// network, the model name, or the model itself.
//
//   npx tsx scripts/probe-llm.ts
//   DRAFT_PRESET=dashscope DRAFT_API_KEY=sk-... npx tsx scripts/probe-llm.ts
import { chatComplete, listChatModels } from "../server/chat-client";
import { describeChatConfig, resolveChatConfig } from "../server/chat-config";

async function main() {
  let cfg;
  try {
    cfg = resolveChatConfig();
  } catch (err) {
    console.error("[probe] 配置有误：", err instanceof Error ? err.message : err);
    process.exit(2);
  }
  if (!cfg) {
    console.error("[probe] 没有配置聊天模型。设置 DRAFT_PRESET 或写 .runtime/chat.json。");
    process.exit(2);
  }
  console.log(describeChatConfig(cfg));

  // 1. Is the endpoint reachable at all?
  try {
    const models = await listChatModels(cfg);
    console.log(`[probe] GET /models OK，共 ${models.length} 个模型`);
    if (models.length > 0) console.log("        可用：" + models.slice(0, 8).join(", "));
    if (models.length > 0 && !models.some((m) => m === cfg!.model || m.startsWith(cfg!.model + ":"))) {
      console.warn(`[probe] 警告：列表里没有 ${cfg.model}，名字可能不对。`);
    }
  } catch (err) {
    console.error("[probe] 连不上或 /models 不可用：", err instanceof Error ? err.message : err);
    console.error("        本机服务请确认已启动；远端请检查 baseUrl 与 Key。");
    process.exit(1);
  }

  // 2. Can it produce the thing we actually need?
  const started = Date.now();
  try {
    const out = await chatComplete(cfg, [
      { role: "system", content: "你是微信回复代笔。只输出一句话，不加引号。 /no_think" },
      { role: "user", content: "对方：今天加班好累，刚到家。\n策略：关心但不纠缠。写一句回复。" },
    ]);
    const took = Date.now() - started;
    console.log(`[probe] 首字生成完成 ${took}ms（模型回报 ${out.model}）`);
    if (out.usage) console.log(`        tokens prompt=${out.usage.prompt} completion=${out.usage.completion}`);
    console.log(`\n回复：${out.text || "（空——可能 tokens 用尽，全部落在思考块里）"}`);
    if (!out.text) process.exit(1);
  } catch (err) {
    console.error("[probe] 生成失败：", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  console.log("\n[probe] 通过。可以跑 scripts/run.ts 了。");
}

main().catch((err) => {
  console.error("[probe] 意外错误：", err);
  process.exit(1);
});
