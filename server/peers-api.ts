// 会话列表与「对方是谁」。
//
// 列表从解密库里按会话聚合出来，用 wxid 当 key、昵称当显示名——改备注不该
// 让一个人变成两个人。设定跟在列表一起返回，前端点到谁就知道要不要弹框问。
import { readFile } from "node:fs/promises";
import { Router } from "express";
import { z } from "zod";
import { listWeChatPeers } from "../shared/wechat-db";
import type { WeChatMapping } from "../shared/wechat-db";
import { listKnownPeers, readPeerState, writePeerState } from "./peer-state";

export const peersRouter = Router();

peersRouter.get("/", async (req, res) => {
  const dbDir = String(req.query.dbDir ?? "").trim();
  const mappingFile = String(req.query.mappingFile ?? "").trim();
  if (!dbDir || !mappingFile) {
    res.status(400).json({ error: "先填解密目录和映射文件。" });
    return;
  }
  try {
    const mapping = JSON.parse(await readFile(mappingFile, "utf8")) as WeChatMapping;
    if (!mapping?.messages?.table || !mapping.messages.columns?.peer) {
      res.status(400).json({ error: "映射文件缺 messages.table / columns.peer。" });
      return;
    }
    const peers = listWeChatPeers({ dbDir, mapping }).map((p) => ({
      ...p,
      ...(readPeerState(p.peer)?.profile
        ? { profile: readPeerState(p.peer)!.profile }
        : {}),
    }));
    res.json({ peers });
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
