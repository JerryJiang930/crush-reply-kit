// IN -> THINK -> OUT orchestrator.
//
// This is the only module that knows all three stages exist. Each stage is
// swappable behind an interface and nothing about a model, peer, or source is
// hardcoded here:
//   IN  : a SourceAdapter (shared/sources.ts) yields NormalizedSession[]
//   THINK: crush-monitor's analyze() driven by an ActiveConfig (local engine)
//   OUT : deliver() copies the suggestion to the clipboard (deliver.ts)
//
// The optional draft step (turn the chosen action into an actual sentence via a
// local chat model) is also pluggable — if no draft endpoint is configured we
// fall back to a structured recommendation, which needs zero extra models.
import { analyze } from "./analysis";
import { overviewJob } from "../shared/incremental";
import type { ActiveConfig } from "./model-config";
import { deliver, type DeliverConfig } from "./deliver";
import { chatComplete } from "./chat-client";
import type { ChatConfig } from "./chat-config";
import {
  ACTIONS,
  STAGES,
  affinityLabel,
  statusLabel,
  type Overview,
} from "../shared/types";
import type { SourceAdapter } from "../shared/sources";

export type { ChatConfig };
/** Kept for callers written before the chat client existed. */
export type DraftConfig = ChatConfig;

export type PipelineConfig = {
  source: SourceAdapter;
  decisionConfig: ActiveConfig;
  deliverConfig: DeliverConfig;
  /** Epoch ms; only sessions with activity after this are processed. */
  sinceMs?: number;
  /** Optional chat model that turns the chosen action into a full reply. */
  draft?: ChatConfig;
  /** Called when a draft fails; defaults to a stderr warning. */
  onDraftError?: (peer: string, message: string) => void;
  /** Relation used by the analyzer; mirrors crush-monitor's relation enum. */
  relation?: "crush" | "new" | "couple";
};

function defaultDraftError(peer: string, message: string): void {
  console.warn(`[replysmith] ${peer} 的草稿生成失败，已退回结构化建议：${message}`);
}

export type PipelineResult = {
  peer: string;
  action: string;
  /** The text handed to deliver() (clipboard or print). */
  text: string;
  /** Human-readable strategy line, kept out of `text` so a paste stays clean. */
  strategy: string;
  /** True when `text` is an actual draft from a chat model. */
  drafted: boolean;
  delivered: boolean;
};

/** Build a human-readable recommendation from the analyzer output. */
export function describeSuggestion(peer: string, overview: Overview): string {
  const action = ACTIONS[overview.action] ?? ACTIONS.insufficient;
  const stage = STAGES[overview.stage] ?? STAGES.unknown;
  const affinity = affinityLabel(overview.affinity?.value ?? null);
  const confidence = statusLabel(overview.affinity);
  const lines = [
    `【replysmith 建议】对方：${peer}`,
    `当前阶段：${stage}`,
    `关系温度：${affinity}（${confidence}）`,
    `下一步：${action.label}`,
    `—— ${action.detail}`,
  ];
  return lines.join("\n");
}

/** Copywriting prompt. Deliberately narrow: one line out, no commentary. */
export const DRAFT_SYSTEM_PROMPT =
  "你是微信聊天的回复代笔。根据对话和给定的策略，写一句自然、简短、像真人随手打出的回复。" +
  "要求：一到两句话，不超过 40 字；不用书面语，不列点，不加引号，不解释为什么这么回。" +
  "只输出这句话本身。 /no_think";

export function buildDraftPrompt(
  overview: Overview,
  recent: string,
): { system: string; user: string } {
  const action = ACTIONS[overview.action] ?? ACTIONS.insufficient;
  return {
    system: DRAFT_SYSTEM_PROMPT,
    user:
      `对话最近内容：\n${recent}\n\n` +
      `关系阶段：${STAGES[overview.stage] ?? STAGES.unknown}\n` +
      `本次策略：${action.label} —— ${action.detail}\n\n` +
      `写一句符合这个策略的回复。`,
  };
}

/**
 * Optional: ask a local chat model for the actual sentence to send, given the
 * chat and the recommended action.
 *
 * Throws on failure — the caller decides whether to fall back. Swallowing the
 * error here once cost a debugging session: the chat service answered 200 on
 * /api/tags while its llama-server had fallen back to the CPU backend and died
 * on every request, so every draft silently degraded to the structured
 * suggestion with no clue why.
 */
async function generateDraft(
  overview: Overview,
  recent: string,
  draft: ChatConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const { system, user } = buildDraftPrompt(overview, recent);
  const result = await chatComplete(
    draft,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    fetchImpl,
  );
  return result.text || null;
}

function lastMessages(session: { messages: { text: string; sender: string }[] }, n = 6): string {
  return session.messages
    .slice(-n)
    .map((m) => `${m.sender === "self" ? "我" : "对方"}：${m.text}`)
    .join("\n");
}

export async function runPipeline(
  cfg: PipelineConfig,
): Promise<PipelineResult[]> {
  const relation = cfg.relation ?? "crush";
  const sessions = await cfg.source.pull(cfg.sinceMs ?? 0);
  const results: PipelineResult[] = [];

  for (const session of sessions) {
    const request = overviewJob(session.messages, relation, 1, {});
    const result = await analyze(request, undefined, cfg.decisionConfig);
    const overview = result.overview;
    if (!overview) {
      results.push({
        peer: session.peer,
        action: "insufficient",
        text: `【replysmith】对方：${session.peer}\n分析未返回结果，请稍后重试。`,
        strategy: "分析未返回结果",
        drafted: false,
        delivered: false,
      });
      continue;
    }

    const action = ACTIONS[overview.action] ?? ACTIONS.insufficient;
    const strategy = `${action.label} —— ${action.detail}`;
    let text = describeSuggestion(session.peer, overview);
    let drafted = false;

    if (cfg.draft) {
      try {
        const draft = await generateDraft(overview, lastMessages(session), cfg.draft);
        if (draft) {
          // Keep the paste clean: the sentence only. The strategy travels beside
          // it in `strategy` so the terminal (or UI) can show it separately.
          text = draft;
          drafted = true;
        }
      } catch (err) {
        // A dead chat model must not sink the whole run: we still have the
        // strategy. But say why, loudly enough to notice.
        const msg = err instanceof Error ? err.message : String(err);
        (cfg.onDraftError ?? defaultDraftError)(session.peer, msg);
      }
    }

    const { delivered } = await deliver(text, cfg.deliverConfig);
    results.push({
      peer: session.peer,
      action: overview.action,
      text,
      strategy,
      drafted,
      delivered,
    });
  }
  return results;
}
