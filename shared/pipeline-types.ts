// 链路最终产出的类型。放在共享层，纯类型、零运行时依赖，
// 这样前端（vite 打包）和后端（node:sqlite / fetch）都能 import 而不用
// 把 node-only 模块拖进浏览器包里。
//
// 一份数据，两种渲染器：终端的 report.ts 和网页的 App.tsx。谁都不是另一边的
// 上游——它们都只是 SessionReport 的不同呈现。
import type { LineResult, Message, Overview, Relation } from "./types";

export type CandidateSource = "primary" | "alternative" | "caution";

/**
 * 聊天记录读不出来的东西：多大、做什么的、什么脾气。
 * 判断模型只看得见文本，这些只能由人补，补了写出来的句子才像在跟这个具体的人说话。
 */
export type Profile = {
  age?: string;
  role?: string;
  note?: string;
};

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
  /** 显示名。 */
  peer: string;
  /** 稳定 id（wxid）。存游标、存设定都用它，昵称会变。 */
  peerId: string;
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
