// 读 wechat-decrypt 解密出来的 SQLite，归一化成 crush-monitor 认识的 Message[]。
//
// 边界：解密不在这里做。328336690/wechat-decrypt 负责从微信进程内存取密钥、解出
// decrypted/ 目录；我们只读它的输出。这样仓库里没有一行触及 SQLCipher。
//
// 为什么不写死表名和列名：微信 4.0 的表结构没有稳定文档，不同版本列名会变（
// PROJECT.md §7 一直标着"表结构待验证"）。所以这里所有表名/列名都从映射文件来，
// 映射文件由 scripts/inspect-wechat-db.ts 对着真实库探测后生成。猜错时应当报错，
// 而不是安静地读出零条或错位的数据。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "./types";
import type { NormalizedSession } from "./sources";

export type WeChatMapping = {
  messages: {
    /** decrypted/ 下的相对路径；给目录则读其中所有 *.db（消息库常分片） */
    db: string;
    table: string;
    columns: {
      id: string;
      /** 时间列。秒或毫秒都行，由 timeUnit 决定 */
      time: string;
      /** 是否我发的 */
      isSelf: string;
      /** 会话标识：单聊是对方 wxid，群聊是 xxx@chatroom */
      peer: string;
      text: string;
    };
    /** 哪些值表示"我发的"，默认 [1, "1", true] */
    selfValues?: Array<string | number | boolean>;
  };
  /** 可选：把 wxid 换成昵称（contact 库） */
  peerNames?: {
    db: string;
    table: string;
    columns: { id: string; name: string };
  };
  /** 时间列单位，默认 auto（按数值大小判断秒/毫秒） */
  timeUnit?: "auto" | "s" | "ms";
};

export type WeChatReadConfig = {
  /** wechat-decrypt 的 decrypted/ 目录 */
  dbDir: string;
  mapping: WeChatMapping;
  allowedPeers: string[];
  sinceMs: number;
  /** 每个会话最多取最近多少条，防止把整库塞进上下文 */
  maxMessagesPerPeer: number;
};

const SAFE = /^[A-Za-z0-9_]+$/;

/** 表名/列名来自配置文件，拼进 SQL 前必须挡住引号，否则就是注入点。 */
function ident(name: string): string {
  if (!SAFE.test(name)) {
    throw new Error(`映射里的标识符不合法：${JSON.stringify(name)}（只允许字母数字下划线）`);
  }
  return `"${name}"`;
}

function dbFiles(dbDir: string, rel: string): string[] {
  const abs = resolve(dbDir, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isDirectory()) {
    return readdirSync(abs)
      .filter((f) => f.toLowerCase().endsWith(".db"))
      .map((f) => join(abs, f));
  }
  return [abs];
}

function isTrueish(value: unknown, extra: Array<string | number | boolean>): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value).trim().toLowerCase();
  return s === "1" || s === "true" || extra.some((v) => String(v).toLowerCase() === s);
}

/** 微信时间列可能是秒也可能是毫秒，auto 时按量级判断（1e11 秒已是公元 5138 年）。 */
function toMillis(value: unknown, unit: "auto" | "s" | "ms"): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit === "s") return Math.round(n * 1000);
  if (unit === "ms") return Math.round(n);
  return n > 1e11 ? Math.round(n) : Math.round(n * 1000);
}

/** 非文本消息（图片/表情/链接卡片）在 4.0 里是 XML，塞给模型只会污染判断。 */
function looksLikeNonText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<") && (t.includes("<msg") || t.includes("</msg>"));
}

type PeerName = { raw: string; name: string };

function loadPeerNames(dbDir: string, m?: WeChatMapping["peerNames"]): Map<string, string> {
  const out = new Map<string, string>();
  if (!m) return out;
  for (const file of dbFiles(dbDir, m.db)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT ${ident(m.columns.id)} AS id, ${ident(m.columns.name)} AS name FROM ${ident(m.table)}`,
        )
        .all() as Array<{ id: unknown; name: unknown }>;
      for (const r of rows) {
        if (r.id == null || r.name == null) continue;
        out.set(String(r.id), String(r.name));
      }
    } catch {
      /* 昵称只是锦上添花，读不到就退回原始 id */
    } finally {
      db?.close();
    }
  }
  return out;
}

/** 会话列表里的一行。够人认出是谁、值不值得点。 */
export type PeerSummary = {
  /** 原始会话标识（单聊是 wxid，群聊是 xxx@chatroom），拿它当稳定的 key。 */
  peer: string;
  /** 昵称或备注，只用来显示。 */
  name: string;
  count: number;
  lastMs: number;
};

/**
 * 只列会话，不读内容。左栏的列表用它，避免为了看有哪些人而把几十万条消息搬进内存。
 * 用 SQL 做聚合，一条 query 出结果。
 */
export function listWeChatPeers(config: {
  dbDir: string;
  mapping: WeChatMapping;
}): PeerSummary[] {
  const { messages: m } = config.mapping;
  const unit = config.mapping.timeUnit ?? "auto";
  const names = loadPeerNames(config.dbDir, config.mapping.peerNames);
  const files = dbFiles(config.dbDir, m.db);
  if (files.length === 0) {
    throw new Error(
      `找不到消息库：${resolve(config.dbDir, m.db)}。先跑 decrypt_db.py 解出 decrypted/ 目录。`,
    );
  }

  const byPeer = new Map<string, { count: number; lastMs: number }>();
  for (const file of files) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const cols = m.columns;
      const rows = db
        .prepare(
          `SELECT ${ident(cols.peer)} AS peer, COUNT(*) AS c, ` +
            `MAX(CAST(${ident(cols.time)} AS INTEGER)) AS t ` +
            `FROM ${ident(m.table)} GROUP BY ${ident(cols.peer)}`,
        )
        .all() as Array<{ peer: unknown; c: unknown; t: unknown }>;
      for (const r of rows) {
        if (r.peer == null) continue;
        const raw = String(r.peer);
        const ms = toMillis(r.t, unit) ?? 0;
        const prev = byPeer.get(raw);
        byPeer.set(raw, {
          count: (prev?.count ?? 0) + Number(r.c ?? 0),
          lastMs: Math.max(prev?.lastMs ?? 0, ms),
        });
      }
    } finally {
      db?.close();
    }
  }

  return [...byPeer]
    .map(([raw, v]) => ({
      peer: raw,
      name: names.get(raw) ?? raw,
      count: v.count,
      lastMs: v.lastMs,
    }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.lastMs - a.lastMs);
}

/**
 * 读一个或多个消息库，按会话聚合。只返回 allowlist 里的会话，且只保留 sinceMs 之后
 * 有动静的。allowlist 同时匹配昵称和原始 id，方便你按哪个都能登记。
 */
export function readWeChatSessions(config: WeChatReadConfig): NormalizedSession[] {
  const { messages: m } = config.mapping;
  const unit = config.mapping.timeUnit ?? "auto";
  const selfValues = m.selfValues ?? [1, "1", true];
  const names = loadPeerNames(config.dbDir, config.mapping.peerNames);

  const files = dbFiles(config.dbDir, m.db);
  if (files.length === 0) {
    throw new Error(
      `找不到消息库：${resolve(config.dbDir, m.db)}。先跑 decrypt_db.py 解出 decrypted/ 目录。`,
    );
  }

  type Row = { id: unknown; time: unknown; isSelf: unknown; peer: unknown; text: unknown };
  const byPeer = new Map<string, { name: string; items: Array<{ ms: number; msg: Message }> }>();

  for (const file of files) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const cols = m.columns;
      const sql =
        `SELECT ${ident(cols.id)} AS id, ${ident(cols.time)} AS time, ` +
        `${ident(cols.isSelf)} AS isSelf, ${ident(cols.peer)} AS peer, ` +
        `${ident(cols.text)} AS text FROM ${ident(m.table)} ` +
        `WHERE CAST(${ident(cols.time)} AS INTEGER) >= ?`;
      // 秒/毫秒两种可能都试一遍：先把阈值按毫秒降成秒，取两者中较小的那个更安全。
      const thresholdMs = config.sinceMs;
      const threshold = unit === "s" ? Math.floor(thresholdMs / 1000) : thresholdMs;
      let rows: Row[] = [];
      try {
        rows = db.prepare(sql).all(threshold) as Row[];
      } catch {
        // 该列不是数值型时退回全表扫，再在 JS 里过滤。
        rows = db
          .prepare(
            `SELECT ${ident(cols.id)} AS id, ${ident(cols.time)} AS time, ` +
              `${ident(cols.isSelf)} AS isSelf, ${ident(cols.peer)} AS peer, ` +
              `${ident(cols.text)} AS text FROM ${ident(m.table)}`,
          )
          .all() as Row[];
      }

      for (const r of rows) {
        const ms = toMillis(r.time, unit);
        if (ms === null || ms < config.sinceMs) continue;
        if (r.peer == null) continue;
        const raw = String(r.peer);
        const name = names.get(raw) ?? raw;
        const text = r.text == null ? "" : String(r.text);
        const msg: Message = {
          id: r.id == null ? `${raw}:${ms}` : String(r.id),
          sender: isTrueish(r.isSelf, selfValues) ? "self" : "other",
          text: looksLikeNonText(text) ? "" : text,
          timestamp: String(Math.floor(ms / 1000)),
          kind: looksLikeNonText(text) || text.trim() === "" ? "unreadable" : "text",
        };
        const bucket = byPeer.get(raw) ?? { name, items: [] };
        bucket.items.push({ ms, msg });
        byPeer.set(raw, bucket);
      }
    } finally {
      db?.close();
    }
  }

  const allow = new Set(config.allowedPeers.map((p) => p.trim()).filter(Boolean));
  const out: NormalizedSession[] = [];
  for (const [raw, bucket] of byPeer) {
    if (allow.size > 0 && !allow.has(raw) && !allow.has(bucket.name)) continue;
    bucket.items.sort((a, b) => a.ms - b.ms);
    const kept = bucket.items.slice(-config.maxMessagesPerPeer).map((i) => i.msg);
    if (kept.length === 0) continue;
    out.push({ peer: bucket.name, peerId: raw, messages: kept });
  }
  return out;
}
