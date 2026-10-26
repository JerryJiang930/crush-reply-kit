// Turning one judgment into several reply directions.
//
// The analyzer already commits to two: `action` (what it would do) and
// `alternative` (the other road it weighed). A third comes from a rule: when
// the primary is forward-leaning, show the step back; when it is already
// holding, show the close. Three directions is the point where a choice still
// means something; five would just be a menu.
import { ACTIONS, STAGES, type Overview } from "../shared/types";
import { chatComplete } from "./chat-client";
import type { ChatConfig } from "./chat-config";

export type Candidate = {
  /** Action key from ACTIONS. */
  action: string;
  label: string;
  detail: string;
  /** The sentence to send; null when the direction is "say nothing yet". */
  text: string | null;
  source: "primary" | "alternative" | "caution";
};

/** Actions where the right move is silence, so there is nothing to draft. */
const SILENT = new Set(["wait", "respect"]);

/**
 * Where to step back to, given the primary action. Each entry is a calmer
 * neighbour, not a random other option: the point of the third candidate is to
 * show the reader what holding back would look like.
 */
const STEP_BACK: Record<string, string> = {
  invite: "flirt",
  flirt: "continue",
  ask: "empathize",
  clarify: "empathize",
  empathize: "continue",
  continue: "wait",
  close: "wait",
  wait: "close",
  respect: "close",
};

export function planDirections(
  overview: Overview,
): { action: string; source: Candidate["source"] }[] {
  const primary = ACTIONS[overview.action] ? overview.action : "insufficient";
  // A stated boundary is not a menu. Offer respect and nothing that pushes.
  if (overview.boundaryApplied || primary === "respect") {
    return [{ action: "respect", source: "primary" }];
  }
  if (primary === "insufficient") return [{ action: "insufficient", source: "primary" }];

  const plan: { action: string; source: Candidate["source"] }[] = [
    { action: primary, source: "primary" },
  ];
  const seen = new Set([primary]);

  const alt = overview.alternative;
  if (alt && ACTIONS[alt] && !seen.has(alt)) {
    plan.push({ action: alt, source: "alternative" });
    seen.add(alt);
  }

  const back = STEP_BACK[primary];
  if (back && ACTIONS[back] && !seen.has(back)) {
    plan.push({ action: back, source: "caution" });
    seen.add(back);
  }

  return plan;
}

/** Copywriting prompt. Deliberately narrow: one line out, no commentary. */
export const DRAFT_SYSTEM_PROMPT =
  "你是微信聊天的回复代笔。根据对话和给定的策略，写一句自然、简短、像真人随手打出的回复。" +
  "要求：一到两句话，不超过 40 字；不用书面语，不列点，不加引号，不解释为什么这么回。" +
  "只输出这句话本身。 /no_think";

export function buildDraftPrompt(
  overview: Overview,
  recent: string,
  actionKey: string = overview.action,
): { system: string; user: string } {
  const action = ACTIONS[actionKey] ?? ACTIONS.insufficient;
  return {
    system: DRAFT_SYSTEM_PROMPT,
    user:
      `对话最近内容：\n${recent}\n\n` +
      `关系阶段：${STAGES[overview.stage] ?? STAGES.unknown}\n` +
      `本轮方向：${action.label} —— ${action.detail}\n\n` +
      `写一句符合这个方向的回复。`,
  };
}

export type DraftDeps = {
  /** Chat model config; when absent, candidates carry strategy only. */
  chat?: ChatConfig;
  recent: string;
  count?: number;
  fetchImpl?: typeof fetch;
  /** Called per failed draft; the candidate stays, its text stays null. */
  onError?: (actionKey: string, message: string) => void;
};

/**
 * One chat call per direction. Sequential on purpose: a local GPU serialises
 * them anyway, and running them in parallel just makes the first token arrive
 * later for all three.
 *
 * A failure on one direction does not sink the others: the reader still gets
 * the strategy, which is the part worth reading.
 */
export async function draftCandidates(
  overview: Overview,
  deps: DraftDeps,
): Promise<Candidate[]> {
  const plan = planDirections(overview).slice(0, Math.max(1, deps.count ?? 3));

  return Promise.all(
    plan.map(async ({ action, source }): Promise<Candidate> => {
      const a = ACTIONS[action] ?? ACTIONS.insufficient;
      const base = { action, label: a.label, detail: a.detail, source };
      if (!deps.chat || SILENT.has(action)) return { ...base, text: null };

      const { system, user } = buildDraftPrompt(overview, deps.recent, action);
      try {
        const result = await chatComplete(
          deps.chat,
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          deps.fetchImpl,
        );
        return { ...base, text: result.text || null };
      } catch (err) {
        deps.onError?.(action, err instanceof Error ? err.message : String(err));
        return { ...base, text: null };
      }
    }),
  );
}
