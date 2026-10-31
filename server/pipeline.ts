// IN -> THINK -> OUT orchestrator.
//
// This is the only module that knows all three stages exist. Each stage is
// swappable behind an interface and nothing about a model, peer, or source is
// hardcoded here:
//   IN  : a SourceAdapter (shared/sources.ts) yields NormalizedSession[]
//   THINK: crush-monitor's analyze(), driven by a decision config
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
import type { Message } from "../shared/types";
import type { ActiveConfig } from "./model-config";
import { draftCandidates, judgmentSignals, type Candidate } from "./candidates";
import { summarizeOlder } from "./summarize";
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
  /** 起草时给模型看多少条历史。太短就只能在原地打转。 */
  draftContext?: number;
  /** 更早部分的摘要存在哪，按 peer 取。不传就不做摘要。 */
  peerSummary?: (peer: string) => {
    read(): string | null;
    write(text: string, upToId: string): void;
  };
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
  console.warn(`[crush-reply-kit] ${peer} 的「${action}」方向没写出来：${message}`);
}

/** Merge per-message judgments; a later job may fill fields an earlier one left. */
function mergeLines(into: Map<string, LineResult>, incoming?: LineResult[]): void {
  for (const line of incoming ?? []) {
    const prev = into.get(line.id);
    into.set(line.id, prev ? { ...prev, ...line } : line);
  }
}

function lastMessages(
  messages: { text: string; sender: string; senderName?: string }[],
  n = 8,
): string {
  return messages
    // 图片和表情在库里是空文本，留着只会让模型以为有人没说话。
    .filter((m) => m.text.trim())
    .slice(-n)
    .map(
      (m) =>
        `${m.senderName || (m.sender === "self" ? "我" : "对方")}：${m.text}`,
    )
    .join("\n");
}

export async function runPipeline(
  cfg: PipelineConfig,
): Promise<SessionReport[]> {
    const relation = cfg.relation ?? "crush";
    const sessions = await cfg.source.pull(cfg.sinceMs ?? 0);
    const reports: SessionReport[] = [];

    for (const session of sessions) {
      const messages = session.messages;
      // 判定窗口跟展示窗口对齐：前端不传时，lineWindow 取 messageWindow，都没有就判全部。
      // 逐句是一条一次请求，几千条能把模型压死，所以这里再封一道 60 的顶。
      const windowHint =
        cfg.lineWindow && cfg.lineWindow > 0
          ? cfg.lineWindow
          : cfg.messageWindow && cfg.messageWindow > 0
            ? cfg.messageWindow
            : messages.length;
      const lineWindow = Math.min(Math.max(0, windowHint), 60);
    if (!messages.length) {
      reports.push({
        peer: session.peer,
        peerId: session.peerId ?? session.peer,
        relation,
        overview: null,
        lines: [],
        messages: [],
        candidates: [],
        note: "这个会话没有可读的文本消息。",
      });
      continue;
    }

    const judgeMessages = messages;

    // 1. The relationship reading.
    const overviewResult = await analyze(
      overviewJob(judgeMessages, relation, 1, {}, cfg.profile),
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
      const jobs = incrementalJobs(
        judgeMessages,
        relation,
        1,
        {},
        {},
        true,
        cfg.profile,
      ).filter((job) => job.targetIds.some((id) => visible.has(id)));
      const batches = jobs;
      for (const job of batches) {
        const result = await analyze(job, undefined, cfg.decisionConfig);
        mergeLines(lines, result.lines);
      }
    }

    const displayWindow =
      cfg.messageWindow && cfg.messageWindow > 0
        ? cfg.messageWindow
        : messages.length;
    const visibleMessages = messages.slice(-displayWindow);

    // 超出起草窗口的那部分先压成摘要：模型自己不会总结，塞超了只会被从前面截断。
    const contextLines = cfg.draftContext ?? 30;
    let earlier: string | undefined;
    if (
      cfg.draft &&
      cfg.peerSummary &&
      visibleMessages.length > contextLines + 10
    ) {
      const older = visibleMessages.slice(0, -contextLines);
      try {
        const store = cfg.peerSummary(session.peer);
        const text = await summarizeOlder(older, cfg.draft, store.read());
        if (text) {
          earlier = text;
          store.write(text, older.at(-1)?.id ?? "");
        }
      } catch (err) {
        (cfg.onDraftError ?? defaultDraftError)(
          session.peer,
          "summary",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const candidates = overview
      ? await draftCandidates(overview, {
          chat: cfg.draft,
          recent: lastMessages(visibleMessages, contextLines),
          earlier,
          count: cfg.candidates,
          profile: cfg.profile,
          signals: judgmentSignals(overview, [...lines.values()], visibleMessages),
          onError: (action, message) =>
            (cfg.onDraftError ?? defaultDraftError)(session.peer, action, message),
        })
      : [];

    reports.push({
      peer: session.peer,
      peerId: session.peerId ?? session.peer,
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
