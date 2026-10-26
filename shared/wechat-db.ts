// 读 wechat-decrypt 解出来的 4.1 库。
//
// 4.1 的结构和 4.0 完全不同，别拿 4.0 的经验套：
//   - 没有一张"所有消息"的大表。每个会话一张 `Msg_<md5(username)>`，散在
//     message/message_0..3.db 里。
//   - 会话本身在 session/session.db 的 SessionTable，带 sort_timestamp 和 summary。
//   - 消息的发送者是编号，要拿 real_sender_id 回 Name2Id 换成 wxid。
//   - 时间是秒。
//
// 所以本文件不再靠外部映射文件猜列名：列名是固定的，写死反而看得清。真要变了，
// 这里会直接抛错，而不是安静读出零条。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "./types";
import type { NormalizedSession } from "./sources";

export type WeChatConfig = {
  /** wechat-decrypt 输出的 decrypted/ 目录。 */
  dbDir: string;
  /** 自己的 wxid。不给就从目录名推（wxid_xxx_b16e → wxid_xxx）。 */
  selfId?: string;
};

export type PeerSummary = {
  /** 稳定 key：对方的 wxid 或 xxx@chatroom。 */
  peer: string;
  /** 昵称或备注，只用来显示。 */
  name: string;
  count: number;
  lastMs: number;
};

const TEXT = 1;

function open(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true });
}

function tableIn(dbFile: string, table: string): boolean {
  const db = open(dbFile);
  try {
    return !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
  } finally {
    db.close();
  }
}

/** 微信把会话名取 md5 当表名，这是连接两者的唯一桥。 */
export function msgTable(username: string): string {
  return `Msg_${createHash("md5").update(username).digest("hex")}`;
}

function messageDbs(dbDir: string): string[] {
  const dir = resolve(dbDir, "message");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^message_\d+\.db$/i.test(f))
    .map((f) => join(dir, f));
}

/**
 * 自己的 wxid。优先读 decrypted/ 旁边的 owner.json（解密时写进去的），
 * 读不到再从目录名猜——但解密产物搬过位置就猜不出来，那时候所有消息都会被
 * 当成对方说的，判断直接失真。
 */
function resolveSelf(dbDir: string): string {
  try {
    const f = resolve(dbDir, "..", "owner.json");
    if (existsSync(f)) {
      const id = (JSON.parse(readFileSync(f, "utf8")) as { selfId?: string }).selfId;
      if (id) return id;
    }
  } catch {
    /* 落到目录名推断 */
  }
  const m = basename(resolve(dbDir, "..")).match(/^(wxid_[a-z0-9]+)_[a-z0-9]+$/i);
  return m ? m[1] : "";
}

type NameRow = { rowid: number; user_name: string };

/** 每个消息库各有一份 Name2Id，编号只在库内有效，不能跨库混用。 */
function nameMap(dbFile: string): Map<number, string> {
  const out = new Map<number, string>();
  const db = open(dbFile);
  try {
    for (const r of db.prepare("SELECT rowid, user_name FROM Name2Id").all() as NameRow[])
      out.set(Number(r.rowid), String(r.user_name ?? ""));
  } finally {
    db.close();
  }
  return out;
}

/** 备注优先，其次昵称，再次微信号，都没有就用 wxid。 */
function displayNames(dbDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = resolve(dbDir, "contact/contact.db");
  if (!existsSync(file)) return out;
  const db = open(file);
  try {
    const rows = db
      .prepare(
        "SELECT username, remark, nick_name, alias FROM contact WHERE username IS NOT NULL",
      )
      .all() as Array<{
      username: string;
      remark: string | null;
      nick_name: string | null;
      alias: string | null;
    }>;
    for (const r of rows) {
      const name = [r.remark, r.nick_name, r.alias].find((v) => v && String(v).trim());
      if (name) out.set(String(r.username), String(name));
    }
  } catch {
    /* 备注只是显示，读不到就退回 wxid */
  } finally {
    db.close();
  }
  return out;
}

/**
 * 列会话。用 SessionTable 的 sort_timestamp 排序，不逐表 count：三百多个会话
 * 数一遍要好几秒，而"最近有没有动静"才是列表要回答的问题。
 */
export function listWeChatPeers(cfg: WeChatConfig): PeerSummary[] {
  const file = resolve(cfg.dbDir, "session/session.db");
  if (!existsSync(file)) {
    throw new Error(`找不到 ${file}。确认指到的是 decrypted/ 目录。`);
  }
  const names = displayNames(cfg.dbDir);
  const db = open(file);
  try {
    const rows = db
      .prepare(
        "SELECT username, sort_timestamp, last_timestamp FROM SessionTable WHERE username IS NOT NULL",
      )
      .all() as Array<{
      username: string;
      sort_timestamp: number | null;
      last_timestamp: number | null;
    }>;
    return rows
      .map((r) => {
        const user = String(r.username);
        const ts = Number(r.last_timestamp || r.sort_timestamp || 0);
        return {
          peer: user,
          name: names.get(user) ?? user,
          count: 0,
          lastMs: ts > 0 ? ts * 1000 : 0,
        };
      })
      // 只留真人和群。公众号、服务号占位、系统号一直在推送，会把列表冲垮。
      .filter((p) => p.peer && (p.peer.startsWith("wxid_") || p.peer.endsWith("@chatroom") || p.peer === "filehelper"))
      .sort((a, b) => b.lastMs - a.lastMs);
  } finally {
    db.close();
  }
}

/** 一张 Msg 表在哪个消息库里。表散在 message_0..3，得挨个问。 */
function findTable(dbDir: string, table: string): string | null {
  for (const file of messageDbs(dbDir)) {
    if (tableIn(file, table)) return file;
  }
  return null;
}

type MsgRow = {
  local_id: number;
  real_sender_id: number;
  create_time: number;
  local_type: number;
  message_content: string | null;
};

/** 非文本消息在 4.x 里是 XML，塞给模型只会污染判断。 */
function looksLikeXml(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<") && t.includes("<msg");
}

/**
 * 读一个会话。只返回 allowlist 内的，空白名单一律拒绝——这条是伦理红线，
 * 不靠调用方自觉。
 */
export function readWeChatSessions(
  cfg: WeChatConfig & {
    allowedPeers: string[];
    sinceMs?: number;
    maxMessagesPerPeer?: number;
  },
): NormalizedSession[] {
  const allow = new Set(cfg.allowedPeers.map((p) => p.trim()).filter(Boolean));
  if (allow.size === 0) throw new Error("必须指定要读的会话。空白名单不启动。");

  const self = cfg.selfId || resolveSelf(cfg.dbDir);
  const since = cfg.sinceMs ?? 0;
  const limit = cfg.maxMessagesPerPeer ?? 200;
  const names = displayNames(cfg.dbDir);
  const out: NormalizedSession[] = [];

  for (const peer of allow) {
    const table = msgTable(peer);
    const file = findTable(cfg.dbDir, table);
    if (!file) continue;

    const db = open(file);
    let rows: MsgRow[] = [];
    try {
      rows = db
        .prepare(
          `SELECT local_id, real_sender_id, create_time, local_type, message_content ` +
            `FROM "${table}" WHERE create_time >= ? ORDER BY create_time DESC LIMIT ?`,
        )
        .all(Math.floor(since / 1000), limit) as MsgRow[];
    } finally {
      db.close();
    }
    if (!rows.length) continue;

    const senders = nameMap(file);
    const messages: Message[] = rows
      .reverse()
      .map((r) => {
        const from = senders.get(Number(r.real_sender_id)) ?? "";
        const mine = !!self && from === self;
        const text = r.message_content == null ? "" : String(r.message_content);
        const readable = Number(r.local_type) === TEXT && !!text.trim() && !looksLikeXml(text);
        return {
          id: `${peer}:${r.local_id}`,
          sender: mine ? ("self" as const) : ("other" as const),
          senderName: mine ? "我" : (names.get(from) ?? from),
          text: readable ? text : "",
          timestamp: String(Math.floor(Number(r.create_time))),
          kind: readable ? ("text" as const) : ("unreadable" as const),
        };
      });

    out.push({
      peer: names.get(peer) ?? peer,
      peerId: peer,
      messages,
    });
  }
  return out;
}
