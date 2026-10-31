// 会话列表与「对方是谁」。
//
// 列表从解密库里按会话聚合出来，用 wxid 当 key、昵称当显示名——改备注不该
// 让一个人变成两个人。设定跟在列表一起返回，前端点到谁就知道要不要弹框问。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import type { SessionReport } from "../shared/pipeline-types";
import { listWeChatPeers } from "../shared/wechat-db";
import {
  listKnownPeers,
  readPeerReport,
  readPeerState,
  writePeerState,
  type PeerReportFile,
} from "./peer-state";
import { syncWeChat } from "./wechat-sync";

export const peersRouter = Router();

/**
 * 自动找微信数据目录。Windows 上 4.0 放在 用户目录\xwechat_files\<wxid>\db_storage，
 * 换机器或换账号时目录名会变，所以按"最近还在写"挑一个，不写死。
 */
function locateDbDir(): string | null {
  const roots: string[] = [];
  // 解密产物放进项目里，路径固定，用户不用记也不用填。
  roots.push(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".runtime", "wechat"));
  for (const base of [homedir(), "D:/", "C:/"]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      if (/wechat.*decrypt|wcdb/i.test(entry)) roots.push(join(base, entry));
    }
  }

  // 只认真正解出来的库：有 session/session.db 且消息目录里有 .db。
  const candidates: { dir: string; at: number }[] = [];
  for (const root of roots) {
    const stack = [root];
    for (let depth = 0; stack.length && depth < 4; depth++) {
      const next: string[] = [];
      for (const dir of stack) {
        if (existsSync(join(dir, "session/session.db"))) {
          candidates.push({ dir, at: statSync(join(dir, "session/session.db")).mtimeMs });
        }
        try {
          for (const sub of readdirSync(dir, { withFileTypes: true }))
            if (sub.isDirectory() && !sub.name.startsWith("."))
              next.push(join(dir, sub.name));
        } catch {
          /* 没权限就跳过 */
        }
      }
      stack.length = 0;
      stack.push(...next);
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0]?.dir ?? null;
}

/** 映射文件固定放这里，跑过一次 inspect 之后就一直在。 */
export const mappingPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".runtime",
  "wechat-mapping.json",
);

peersRouter.get("/", (req, res) => {
  // 不带参数就自己找：把这个目录甩给用户去翻是不合理的。
  const dbDir = String(req.query.dbDir ?? "").trim() || locateDbDir();
  if (!dbDir) {
    res.status(404).json({ error: "没找到微信数据目录。" });
    return;
  }
  try {
    const peers = listWeChatPeers({ dbDir }).map((p) => {
      const profile = readPeerState(p.peer)?.profile;
      return profile ? { ...p, profile } : p;
    });
    res.json({ peers, dbDir });
  } catch (e) {
    res
      .status(400)
      .json({ error: e instanceof Error ? e.message : "读不出会话列表。" });
  }
});

/** 分析之前先把加密库解一遍，让快照跟上微信里的新消息。 */
peersRouter.post("/sync", async (_req, res) => {
  const result = await syncWeChat();
  res.status(result.ok ? 200 : 500).json(result);
});

/** 没有库目录时也能用：已经建过基线的人。 */
peersRouter.get("/known", (_req, res) => {
  res.json({ peers: listKnownPeers() });
});

const lastReportPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".runtime",
  "last-report.json",
);

/** 老版本只留了全局一份报告，还没按人拆。按人拆之前，先从这里兜一次底。 */
function legacyReportFor(peer: string): PeerReportFile | null {
  try {
    const raw = JSON.parse(readFileSync(lastReportPath, "utf8")) as {
      at?: number;
      relation?: string;
      reports?: SessionReport[];
    };
    const reports = (raw.reports ?? []).filter(
      (r) => r.peerId === peer || r.peer === peer,
    );
    if (!reports.length) return null;
    return { at: raw.at ?? Date.now(), relation: raw.relation, reports };
  } catch {
    return null;
  }
}

/** 这个人上次分析出来的那份，点回他直接看，不用为了看结果再点一次「开始」。 */
peersRouter.get("/report", (req, res) => {
  const peer = String(req.query.peer ?? "").trim();
  if (!peer) {
    res.status(400).json({ error: "缺少 peer。" });
    return;
  }
  const saved = readPeerReport(peer) ?? legacyReportFor(peer);
  if (!saved) {
    res.status(404).json({ error: "这个人还没分析过。" });
    return;
  }
  res.json(saved);
});

const profileSchema = z
  .object({
    peer: z.string().trim().min(1).max(200),
    name: z.string().trim().max(200).optional(),
    age: z.string().trim().max(20).optional(),
    role: z.string().trim().max(120).optional(),
    note: z.string().trim().max(400).optional(),
    relationNote: z.string().trim().max(400).optional(),
  })
  .strict();

peersRouter.post("/profile", (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "设定格式不正确。" });
    return;
  }
  const { peer, name, age, role, note, relationNote } = parsed.data;
  writePeerState(peer, {
    ...(name ? { name } : {}),
    profile: {
      ...(age ? { age } : {}),
      ...(role ? { role } : {}),
      ...(note ? { note } : {}),
      ...(relationNote ? { relationNote } : {}),
    },
  });
  res.json({ ok: true, peer });
});
