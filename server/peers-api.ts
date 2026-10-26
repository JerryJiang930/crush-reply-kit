// 会话列表与「对方是谁」。
//
// 列表从解密库里按会话聚合出来，用 wxid 当 key、昵称当显示名——改备注不该
// 让一个人变成两个人。设定跟在列表一起返回，前端点到谁就知道要不要弹框问。
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { listWeChatPeers } from "../shared/wechat-db";
import type { WeChatMapping } from "../shared/wechat-db";
import { listKnownPeers, readPeerState, writePeerState } from "./peer-state";

export const peersRouter = Router();

/**
 * 自动找微信数据目录。Windows 上 4.0 放在 用户目录\xwechat_files\<wxid>\db_storage，
 * 换机器或换账号时目录名会变，所以按"最近还在写"挑一个，不写死。
 */
function locateDbDir(): string | null {
  const roots = [
    join(homedir(), "xwechat_files"),
    "D:/xwechat_files",
    "C:/xwechat_files",
  ];
  const candidates: { dir: string; at: number }[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry, "db_storage");
      if (!existsSync(dir)) continue;
      let at = 0;
      for (const sub of ["message", "session", "contact"]) {
        const probe = join(dir, sub);
        if (existsSync(probe)) at = Math.max(at, statSync(probe).mtimeMs);
      }
      candidates.push({ dir, at });
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

peersRouter.get("/", async (req, res) => {
  // 不带参数就自己找：把这个目录甩给用户去翻是不合理的。
  const dbDir = String(req.query.dbDir ?? "").trim() || locateDbDir();
  const mappingFile =
    String(req.query.mappingFile ?? "").trim() ||
    (existsSync(mappingPath) ? mappingPath : "");
  if (!dbDir) {
    res.status(404).json({ error: "没找到微信数据目录。" });
    return;
  }
  if (!mappingFile) {
    res.json({ peers: [], dbDir, mappingFile: "", needMapping: true });
    return;
  }
  try {
    const mapping = JSON.parse(await readFile(mappingFile, "utf8")) as WeChatMapping;
    if (!mapping?.messages?.table || !mapping.messages.columns?.peer) {
      res.status(400).json({ error: "映射文件缺 messages.table / columns.peer。" });
      return;
    }
    const peers = listWeChatPeers({ dbDir, mapping }).map((p) => {
      const profile = readPeerState(p.peer)?.profile;
      return profile ? { ...p, profile } : p;
    });
    res.json({ peers, dbDir, mappingFile });
  } catch (e) {
    res
      .status(400)
      .json({ error: e instanceof Error ? e.message : "读不出会话列表。" });
  }
});

/** 没有库目录时也能用：已经建过基线的人。 */
peersRouter.get("/known", (_req, res) => {
  res.json({ peers: listKnownPeers() });
});

const profileSchema = z
  .object({
    peer: z.string().trim().min(1).max(200),
    name: z.string().trim().max(200).optional(),
    age: z.string().trim().max(20).optional(),
    role: z.string().trim().max(120).optional(),
    note: z.string().trim().max(400).optional(),
  })
  .strict();

peersRouter.post("/profile", (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "设定格式不正确。" });
    return;
  }
  const { peer, name, age, role, note } = parsed.data;
  writePeerState(peer, {
    ...(name ? { name } : {}),
    profile: {
      ...(age ? { age } : {}),
      ...(role ? { role } : {}),
      ...(note ? { note } : {}),
    },
  });
  res.json({ ok: true, peer });
});
