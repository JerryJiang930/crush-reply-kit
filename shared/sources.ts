// IN stage: where do the messages come from?
//
// The pipeline never reads WeChat directly in code we control tightly. Instead
// each source is an adapter that yields *normalized* sessions — a peer id plus
// the same Message[] shape crush-monitor already understands. Swapping "paste a
// file" for "live WeChat" is a config change, not a code change.
//
// IMPORTANT (伦理红线): any source that touches another person's messages must
// only process peers the operator has explicitly allowlisted. The adapters
// enforce `allowedPeers`; an empty allowlist is for local dev only.
import { readFile } from "node:fs/promises";
import type { Message } from "./types";
import { readWeChatSessions, type WeChatMapping } from "./wechat-db";

export type NormalizedSession = {
  /** 显示名（昵称 / 备注）。会变，不要拿它当 key。 */
  peer: string;
  /** 稳定 id（wxid / room id）。有就用它存游标，改备注不影响。 */
  peerId?: string;
  messages: Message[];
};

export type SourceAdapter = {
  id: string;
  /** Return sessions with activity after `sinceMs` (epoch ms). */
  pull(sinceMs: number): Promise<NormalizedSession[]>;
};

export type ManualSourceConfig = {
  kind: "manual";
  /** Path to a JSON file: Array<{ peer: string; messages: Message[] }>. */
  file: string;
  allowedPeers: string[];
};

/**
 * Dev/test source: reads pre-normalized sessions from a JSON file. This is the
 * seam the real WeChat adapter plugs into — same output shape, nothing else
 * changes.
 */
export function createManualSource(config: ManualSourceConfig): SourceAdapter {
  return {
    id: "manual",
    async pull(): Promise<NormalizedSession[]> {
      const raw = await readFile(config.file, "utf8");
      const sessions = JSON.parse(raw) as NormalizedSession[];
      return sessions.filter(
        (s) => config.allowedPeers.length === 0 || config.allowedPeers.includes(s.peer),
      );
    },
  };
}

export type WeChatSourceConfig = {
  kind: "wechat";
  /**
   * 328336690/wechat-decrypt 解出来的 decrypted/ 目录。解密本身是外部工具做的事
   * （需要管理员权限读微信进程内存），本仓库不碰 SQLCipher，只读它的输出。
   */
  dbDir: string;
  /**
   * 表名/列名的映射文件。微信 4.0 的表结构没有稳定文档，所以不写死——先用
   * scripts/inspect-wechat-db.ts 对着真实库探测，把结果填进映射文件。
   */
  mappingFile: string;
  allowedPeers: string[];
  /** 每个会话最多带多少条进上下文，默认 80 */
  maxMessagesPerPeer?: number;
};

/**
 * 读 wechat-decrypt 解密后的本地库。需要你本人在场、微信 4.0 运行中、以管理员权限
 * 先跑完 find_all_keys.py + decrypt_db.py；本适配器不触发任何解密动作。
 */
export function createWeChatSource(config: WeChatSourceConfig): SourceAdapter {
  return {
    id: "wechat",
    async pull(sinceMs: number): Promise<NormalizedSession[]> {
      let mapping: WeChatMapping;
      try {
        mapping = JSON.parse(await readFile(config.mappingFile, "utf8")) as WeChatMapping;
      } catch (err) {
        throw new Error(
          `读不到映射文件 ${config.mappingFile}：` +
            (err instanceof Error ? err.message : String(err)) +
            "。先跑 npx tsx scripts/inspect-wechat-db.ts --dir=<decrypted 目录> --write",
        );
      }
      if (!mapping?.messages?.table || !mapping.messages.columns?.text) {
        throw new Error(
          `映射文件 ${config.mappingFile} 缺 messages.table / messages.columns，` +
            "用 inspect-wechat-db.ts 重新生成再填。",
        );
      }
      return readWeChatSessions({
        dbDir: config.dbDir,
        mapping,
        allowedPeers: config.allowedPeers,
        sinceMs,
        maxMessagesPerPeer: config.maxMessagesPerPeer ?? 80,
      });
    },
  };
}
