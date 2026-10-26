// The report is what THINK actually produced, in full.
//
// Crush-monitor's analyzer returns far more than a next action: per-message
// emotion and intent distributions, an expression-quality score for every line
// you sent, a weighted affinity value across five dimensions. Dropping any of
// that turns the tool into an auto-reply box, so this module keeps the whole
// shape and only decides how to lay it out for a terminal.
import {
  ACTIONS,
  RELATIONS,
  STAGES,
  affinityLabel,
  grade,
  statusLabel,
  type LineResult,
  type Message,
  type Overview,
  type Relation,
} from "../shared/types";
import { topEmotions } from "../shared/labels";
import { topIntents } from "../shared/intents";
import { replyRating } from "../shared/ratings";
import type { Candidate, SessionReport } from "../shared/pipeline-types";

export type { Candidate, SessionReport };

/** Average expression quality over the `self` lines that got scored. */
export function averageQuality(
  messages: Message[],
  lines: LineResult[],
): number | null {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const values = messages
    .filter((m) => m.sender === "self")
    .map((m) => byId.get(m.id)?.score.value)
    .filter((v): v is number => typeof v === "number");
  if (!values.length) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function hhmm(timestamp: string | null): string {
  if (!timestamp) return "--:--";
  const d = new Date(Number.isFinite(Number(timestamp)) ? Number(timestamp) : timestamp);
  if (Number.isNaN(d.getTime())) return "--:--";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "关心 62% · 疑惑 21% · 调侃 9%" */
function distribution(
  items: { label: string; percent: string }[],
): string {
  return items.length
    ? items.map((i) => `${i.label} ${i.percent}`).join(" · ")
    : "—";
}

const W = 46;

export function renderReport(r: SessionReport): string {
  const out: string[] = [];
  const rule = "─".repeat(W);

  out.push(rule);
  out.push(`${r.peer}　${RELATIONS[r.relation]}`);

  const o = r.overview;
  if (!o) {
    out.push(r.note ?? "分析没有返回结果。");
    out.push(rule);
    return out.join("\n");
  }

  // Judgment surfaces first: affinity, stage, and how sure the model is.
  const affinity = o.affinity.value;
  out.push(
    `好感度　${affinity ?? "—"}　${affinityLabel(affinity)}` +
      (o.boundaryApplied ? "（对方已明确划边界，分数已压制）" : ""),
  );
  out.push(`阶段　　${STAGES[o.stage] ?? STAGES.unknown}`);
  out.push(`把握　　${statusLabel(o.affinity)}`);
  if (o.rapport) out.push(`氛围　　${grade(o.rapport.value)}　${statusLabel(o.rapport)}`);

  const quality = averageQuality(r.messages, r.lines);
  const rating = replyRating(quality);
  if (quality !== null) {
    out.push(`表达　　${rating?.label ?? "—"}（${quality}）${rating?.description ?? ""}`);
  }

  if (o.affinityDimensions?.length) {
    out.push("");
    for (const d of o.affinityDimensions) {
      const v = d.judgment.value;
      // judgment() already scales the 0-4 rubric level to 0-100. Printing the
      // raw level next to "/4" reads like a score out of four, which it is not.
      out.push(`　${d.label}　${v === null ? "缺证据" : v}　（权重 ${d.weight}）`);
    }
  }

  if (r.lines.length) {
    out.push("");
    out.push("逐句");
    const byId = new Map(r.lines.map((l) => [l.id, l]));
    for (const m of r.messages) {
      const line = byId.get(m.id);
      const who = m.sender === "self" ? "我　" : "对方";
      const text = m.kind === "unreadable" ? "［图片 / 语音 / 表情，读不出文字］" : m.text;
      out.push(`　${hhmm(m.timestamp)}　${who}　${text.slice(0, 60)}`);
      if (!line) continue;
      const emotions = topEmotions(line.emotions);
      const intents = topIntents(line.intents);
      if (emotions.length) out.push(`　　　　　　　情绪　${distribution(emotions)}`);
      if (intents.length) out.push(`　　　　　　　意图　${distribution(intents)}`);
      const lineRating = replyRating(line.score.value);
      if (lineRating) {
        out.push(`　　　　　　　评级　${lineRating.label}　${lineRating.description}`);
      }
    }
  }

  const action = ACTIONS[o.action] ?? ACTIONS.insufficient;
  out.push("");
  out.push(`下一步　${action.label}`);
  out.push(`　　　　${action.detail}`);
  if (o.alternative && ACTIONS[o.alternative]) {
    out.push(`另一条路　${ACTIONS[o.alternative].label}　${ACTIONS[o.alternative].detail}`);
  }
  const anchor = r.messages.find((m) => m.id === o.actionEvidenceId);
  if (anchor) out.push(`依据　　「${anchor.text.slice(0, 40)}」`);
  out.push(rule);
  return out.join("\n");
}

/** What "no sentence" means for each silent direction. */
const SILENT_NOTE: Record<string, string> = {
  wait: "（不发，先把球留在对方那边）",
  respect: "（不发，尊重对方划的边界）",
};

/** Candidates laid out for a numbered choice. */
export function renderCandidates(cs: Candidate[]): string {
  if (!cs.length) return "没有可发的候选。";
  const lines = cs.map((c, i) => {
    const head = `　${i + 1}　${c.label}`;
    return c.text
      ? `${head}　${c.text}`
      : `${head}　${SILENT_NOTE[c.action] ?? "（这个方向不发）"}`;
  });
  return ["候选", ...lines].join("\n");
}
