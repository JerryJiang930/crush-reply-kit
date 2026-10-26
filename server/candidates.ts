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
import type { Candidate } from "../shared/pipeline-types";

export type { Candidate };

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

/**
 * Fillers for the third slot when the analyzer did not weigh an alternative.
 * Ordered so the first pick is the most usable: a sentence you can actually
 * send beats a direction that means saying nothing.
 */
const FALLBACK: Record<string, string[]> = {
  invite: ["continue", "ask"],
  flirt: ["continue", "invite"],
  ask: ["clarify", "empathize"],
  clarify: ["ask", "continue"],
  empathize: ["continue", "ask"],
  continue: ["empathize", "close"],
  close: ["wait", "continue"],
  wait: ["close", "continue"],
};

function buildPlan(
  primary: string,
  overview: Overview,
  count: number,
): { action: string; source: Candidate["source"] }[] {
  const plan: { action: string; source: Candidate["source"] }[] = [];
  const seen = new Set<string>();
  const add = (action: string | undefined, source: Candidate["source"]) => {
    if (!action || plan.length >= count) return;
    if (!ACTIONS[action] || seen.has(action)) return;
    plan.push({ action, source });
    seen.add(action);
  };

  add(primary, "primary");
  add(overview.alternative, "alternative");
  // 相邻动作先补，退一档放最后——它常常是"先不发"，不该占掉能发的那一格。
  for (const spare of FALLBACK[primary] ?? []) add(spare, "caution");
  add(STEP_BACK[primary], "caution");

  return plan;
}

export function planDirections(
  overview: Overview,
  count = 3,
): { action: string; source: Candidate["source"] }[] {
  const primary = ACTIONS[overview.action] ? overview.action : "insufficient";
  if (primary === "insufficient") return [{ action: "insufficient", source: "primary" }];

  // A stated boundary is not a menu — but only when the model actually knows.
  // Laya leans cautious: on an ordinary "周末有空吗" it scores the no-go
  // question past the threshold about a third of the time. Locking the menu to
  // one silent option on that basis reads as "it refused to answer", so a
  // low-confidence boundary falls back to three sendable directions instead.
  if (overview.boundaryApplied || primary === "respect") {
    if (overview.affinity.status === "clear") {
      return [{ action: "respect", source: "primary" }];
    }
    return buildPlan("continue", overview, count);
    // （status 非 clear 就当没看懂：Laya 的边界判断在低置信度下不成立。）
  }

  return buildPlan(primary, overview, count);
}

/** Copywriting prompt. Deliberately narrow: one line out, no commentary. */
export const DRAFT_SYSTEM_PROMPT =
  "你是微信聊天的回复代笔。根据对话和给定的策略，写一句自然、简短、像真人随手打出的回复。" +
  "要求：一到两句话，不超过 40 字；不用书面语，不列点，不加引号，不解释为什么这么回。" +
  "这是纯线上对话：不能提出见面、吃饭、看电影、接送、一起出门这类线下邀约，" +
  "也不要问对方在哪、什么时候有空。所有推进都只发生在聊天里，靠话题和情绪。" +
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
      `写一句符合这个方向的回复。只聊线上，不提见面和出门。`,
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
  const wanted = Math.max(1, deps.count ?? 3);
  const plan = planDirections(overview, wanted).slice(0, wanted);

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
