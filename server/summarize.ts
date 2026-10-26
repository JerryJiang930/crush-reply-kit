// 把更早的对话压成几句事实，喂给起草模型。
//
// 为什么必须自己做：模型是无状态的，一次调用只看这一次给它的东西。上下文窗口
// 满了不是"自动总结"，是 llama.cpp 从前面截断，最早的话直接消失。所以超过窗口
// 的那部分只能由我们先读、先压缩，再作为一段背景塞回去。
//
// 只压事实，不压判断：聊过什么话题、对方提过什么人什么事、约定了什么、情绪哪里
// 变过。评价和建议留给 OUT 阶段，混进摘要会让起草模型把旧判断当新输入。
import type { Message } from "../shared/types";
import type { ChatConfig } from "./chat-config";
import { chatComplete } from "./chat-client";

export const SUMMARY_SYSTEM =
  "把下面这段聊天压成几句事实摘要，供之后写回复时参考。" +
  "保留：聊过的话题、对方提到的具体的人和事、说好的事、情绪明显变化的地方。" +
  "不要评价，不要给建议，不要写成一个段落。最多五句，每句一行。" +
  "只输出摘要本身。 /no_think";

/** 只留能读出文字的，空消息和图片占位没有摘要价值。 */
function transcript(messages: Message[]): string {
  return messages
    .filter((m) => m.kind === "text" && m.text.trim())
    .map((m) => `${m.sender === "self" ? "我" : "对方"}：${m.text}`)
    .join("\n");
}

/**
 * 返回新的摘要。`prev` 是上一轮的摘要：把它一起给模型，新的几段接在后面，
 * 这样每次只增量压缩，不用把整段历史重读一遍。
 */
export async function summarizeOlder(
  older: Message[],
  chat: ChatConfig,
  prev: string | null,
): Promise<string | null> {
  const body = transcript(older);
  if (!body.trim()) return null;

  const user =
    (prev ? `已有摘要：\n${prev}\n\n补充这一段：\n` : "") +
    // 尾巴比开头有用：越近的事越影响这句话怎么写。
    body.slice(-6000) +
    "\n\n把已有摘要和这一段合起来，重新写成不超过五句。";

  const result = await chatComplete(chat, [
    { role: "system", content: SUMMARY_SYSTEM },
    { role: "user", content: user },
  ]);
  return result.text.trim() || null;
}
