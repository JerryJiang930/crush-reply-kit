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
import { readWeChatSessions } from "./wechat-db";

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
  /** wechat-decrypt 输出的 decrypted/ 目录。 */
  dbDir: string;
  allowedPeers: string[];
  maxMessagesPerPeer?: number;
};

/**
 * 读解密后的本地库。需要你本人在场、微信 4.x 登录中，先跑解密拿到 decrypted/；
 * 本适配器不触发任何解密动作，也不碰 SQLCipher。
 */
export function createWeChatSource(config: WeChatSourceConfig): SourceAdapter {
  return {
    id: "wechat",
    async pull(sinceMs: number): Promise<NormalizedSession[]> {
      return readWeChatSessions({
        dbDir: config.dbDir,
        allowedPeers: config.allowedPeers,
        sinceMs,
        maxMessagesPerPeer: config.maxMessagesPerPeer ?? 200,
      });
    },
  };
}
