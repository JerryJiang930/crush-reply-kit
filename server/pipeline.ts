// IN -> THINK -> OUT orchestrator.
//
// This is the only module that knows all three stages exist. Each stage is
// swappable behind an interface and nothing about a model, peer, or source is
// hardcoded here:
//   IN  : a SourceAdapter (shared/sources.ts) yields NormalizedSession[]
//   THINK: crush-monitor's analyze(), driven by a local decision config
//   OUT : draftCandidates() turns the judgment into several reply directions
//
// THINK runs two kinds of job. `overviewJob` produces the relationship reading
// (affinity across five weighted dimensions, stage, next action plus the
// alternative it weighed). `incrementalJobs` produces the per-message reading
// (emotion and intent distributions for the other side, an expression-quality
// score for yours). Skipping the second one leaves the report with a verdict
// and no evidence, which is exactly the shape of an auto-reply box.
//
// Delivery is not this module's business: it returns reports, and the caller
// decides what to show and what to copy.
import { analyze } from "./analysis";
import { incrementalJobs, overviewJob } from "../shared/incremental";
import type { ActiveConfig } from "./model-config";
import { draftCandidates, type Candidate } from "./candidates";
import type { ChatConfig } from "./chat-config";
import type { LineResult, Relation } from "../shared/types";
import type { SessionReport } from "../shared/pipeline-types";
import type { Profile } from "../shared/pipeline-types";
import type { SourceAdapter } from "../shared/sources";

export type { ChatConfig, Candidate, SessionReport };

export type PipelineConfig = {
  source: SourceAdapter;
  decisionConfig: ActiveConfig;
  /** Epoch ms; only sessions with activity after this are processed. */
  sinceMs?: number;
  /** Optional chat model that writes the candidate sentences. */
  draft?: ChatConfig;
  /** How many recent messages to judge line by line. 0 turns it off. */
  lineWindow?: number;
  /**
   * How many recent messages to include in the returned `messages`. 0 (or
   * omitted) means all of them — needed for the cold-start baseline, which
   * reads the full history and should show it, even though only the tail gets
   * judged line by line.
   */
  messageWindow?: number;
  /** How many reply directions to draft. */
  candidates?: number;
  /** Called when a draft fails; defaults to a stderr warning. */
  onDraftError?: (peer: string, action: string, message: string) => void;
  /** Relation used by the analyzer; mirrors crush-monitor's relation enum. */
  relation?: Relation;
  /** 对方是谁：年龄、身份、脾气。聊天记录里读不出来的，人补。 */
  profile?: Profile;
};

function defaultDraftError(peer: string, action: string, message: string): void {
  console.warn(`[replysmith] ${peer} 的「${action}」方向没写出来：${message}`);
}

/** Merge per-message judgments; a later job may fill fields an earlier one left. */
function mergeLines(into: Map<string, LineResult>, incoming?: LineResult[]): void {
  for (const line of incoming ?? []) {
    const prev = into.get(line.id);
    into.set(line.id, prev ? { ...prev, ...line } : line);
  }
}

function lastMessages(
  messages: { text: string; sender: string }[],
  n = 8,
): string {
  return messages
    .slice(-n)
    .map((m) => `${m.sender === "self" ? "我" : "对方"}：${m.text}`)
    .join("\n");
}

export async function runPipeline(
  cfg: PipelineConfig,
): Promise<SessionReport[]> {
  const relation = cfg.relation ?? "crush";
  const sessions = await cfg.source.pull(cfg.sinceMs ?? 0);
  const reports: SessionReport[] = [];
  const lineWindow = Math.max(0, cfg.lineWindow ?? 12);

  for (const session of sessions) {
    const messages = session.messages;
    if (!messages.length) {
      reports.push({
        peer: session.peer,
        relation,
        overview: null,
        lines: [],
        messages: [],
        candidates: [],
        note: "这个会话没有可读的文本消息。",
      });
      continue;
    }

    // 1. The relationship reading.
    const overviewResult = await analyze(
      overviewJob(messages, relation, 1, {}),
      undefined,
      cfg.decisionConfig,
    );
    const overview = overviewResult.overview ?? null;

    // 2. The per-message reading, bounded to the window the report will show.
    //    incrementalJobs walks the whole history for context, so we keep only
    //    the jobs whose targets land in the visible tail. Otherwise a
    //    200-message backlog becomes forty model calls.
    const lines = new Map<string, LineResult>();
    if (lineWindow > 0 && overview) {
      const visible = new Set(
        messages
          .slice(-lineWindow)
          .filter((m) => m.kind === "text")
          .map((m) => m.id),
      );
      const jobs = incrementalJobs(messages, relation, 1, {}, {}, true).filter(
        (job) => job.targetIds.some((id) => visible.has(id)),
      );
      for (const job of jobs) {
        const result = await analyze(job, undefined, cfg.decisionConfig);
        mergeLines(lines, result.lines);
      }
    }

    const displayWindow =
      cfg.messageWindow && cfg.messageWindow > 0
        ? cfg.messageWindow
        : messages.length;
    const visibleMessages = messages.slice(-displayWindow);

    const candidates = overview
      ? await draftCandidates(overview, {
          chat: cfg.draft,
          recent: lastMessages(visibleMessages),
          count: cfg.candidates,
          profile: cfg.profile,
          onError: (action, message) =>
            (cfg.onDraftError ?? defaultDraftError)(session.peer, action, message),
        })
      : [];

    reports.push({
      peer: session.peer,
      relation,
      overview,
      lines: [...lines.values()],
      messages: visibleMessages,
      candidates,
      ...(overview ? {} : { note: "分析没有返回结果，只处理了下一条会话。" }),
    });
  }
  return reports;
}
