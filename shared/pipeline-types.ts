// 链路最终产出的类型。放在共享层，纯类型、零运行时依赖，
// 这样前端（vite 打包）和后端（node:sqlite / fetch）都能 import 而不用
// 把 node-only 模块拖进浏览器包里。
//
// 一份数据，两种渲染器：终端的 report.ts 和网页的 App.tsx。谁都不是另一边的
// 上游——它们都只是 SessionReport 的不同呈现。
import type { LineResult, Message, Overview, Relation } from "./types";

export type CandidateSource = "primary" | "alternative" | "caution";

/** 一条回复方向。text 为 null 时表示「这个方向先不发」（wait / respect）。 */
export type Candidate = {
  /** ACTIONS 里的动作键。 */
  action: string;
  label: string;
  detail: string;
  /** 该方向写好的回复；沉默类动作这里是 null。 */
  text: string | null;
  source: CandidateSource;
};

/**
 * THINK + OUT 一起跑完后的完整产出。overview 是关系判断（覆盖整段历史），
 * lines 是逐句判断（只覆盖最近的可见窗口，避免长历史变成几十次模型调用），
 * candidates 是从判断里分出来的几个回复方向。
 */
export type SessionReport = {
  peer: string;
  relation: Relation;
  overview: Overview | null;
  /** 逐句判断，按 messages 的顺序用 id 索引。 */
  lines: LineResult[];
  /** 报告里实际展示的消息；冷启动基线模式下是完整历史。 */
  messages: Message[];
  candidates: Candidate[];
  /** 报告为什么单薄（比如没读出来文本）。 */
  note?: string;
};
