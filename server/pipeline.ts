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
import {
  ACTIONS,
  STAGES,
  affinityLabel,
  statusLabel,
  type Overview,
} from "../shared/types";
import type { SourceAdapter } from "../shared/sources";

export type DraftConfig = {
  /** OpenAI-compatible /chat/completions base URL, e.g. http://127.0.0.1:11434/v1 */
  endpoint: string;
  model: string;
  apiKey: string;
};

export type PipelineConfig = {
  source: SourceAdapter;
  decisionConfig: ActiveConfig;
  deliverConfig: DeliverConfig;
  /** Epoch ms; only sessions with activity after this are processed. */
  sinceMs?: number;
  /** Optional chat model that turns the chosen action into a full reply. */
  draft?: DraftConfig;
  /** Relation used by the analyzer; mirrors crush-monitor's relation enum. */
  relation?: "crush" | "new" | "couple";
};

export type PipelineResult = {
  peer: string;
  action: string;
  /** The text handed to deliver() (clipboard or print). */
  text: string;
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

/**
 * Optional: ask a local chat model for the actual sentence to send, given the
 * chat and the recommended action. Never throws — on any failure we fall back
 * to the structured recommendation so the pipeline still produces output.
 */
async function generateDraft(
  peer: string,
  overview: Overview,
  recent: string,
  draft: DraftConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const action = ACTIONS[overview.action] ?? ACTIONS.insufficient;
  const system =
    "你是微信聊天里的回复助手。根据对话和给出的策略，写一句自然、简短、像真人会发的回复。" +
    "不要解释、不要列点、不要加引号，只输出那一句话。";
  const user =
    `对话最近内容：\n${recent}\n\n` +
    `分析建议的策略是「${action.label}」：${action.detail}\n` +
    `请写出一句符合该策略的回复。`;
  try {
    const res = await fetchImpl(`${draft.endpoint.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${draft.apiKey}`,
      },
      body: JSON.stringify({
        model: draft.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.7,
        max_tokens: 120,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch {
    return null;
  }
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
        delivered: false,
      });
      continue;
    }

    let text = describeSuggestion(session.peer, overview);
    if (cfg.draft) {
      const draft = await generateDraft(
        session.peer,
        overview,
        lastMessages(session),
        cfg.draft,
      );
      if (draft) {
        const action = ACTIONS[overview.action] ?? ACTIONS.insufficient;
        text = `${draft}\n\n（策略：${action.label} — ${action.detail}）`;
      }
    }

    const { delivered } = await deliver(text, cfg.deliverConfig);
    results.push({
      peer: session.peer,
      action: overview.action,
      text,
      delivered,
    });
  }
  return results;
}
