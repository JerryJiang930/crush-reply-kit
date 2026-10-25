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
import type { Message } from "./types";

export type NormalizedSession = {
  /** Stable peer identifier (WeChat nickname / room id). */
  peer: string;
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
      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(config.file, "utf8"),
      );
      const sessions = JSON.parse(raw) as NormalizedSession[];
      return sessions.filter(
        (s) => config.allowedPeers.length === 0 || config.allowedPeers.includes(s.peer),
      );
    },
  };
}

export type WeChatDecryptConfig = {
  kind: "wechat-decrypt";
  /** Base URL of the wechat-decrypt helper's local server (e.g. http://127.0.0.1:8000). */
  baseUrl: string;
  /**
   * wechat-decrypt is an EXTERNAL, separately-run tool (328336690/wechat-decrypt,
   * MIT). We do not bundle or run its decryption here. In production you start it
   * yourself with admin rights; this adapter only reads its already-decrypted
   * output over HTTP. The exact response schema MUST be confirmed against a live
   * instance before trusting it — field names below are best-effort.
   */
  allowedPeers: string[];
};

/**
 * Adapter for the external wechat-decrypt helper. Connects to its local server
 * and maps its session shape into NormalizedSession. Not executed automatically
 * against real chat data — requires the operator present and the allowlist set.
 */
export function createWeChatDecryptSource(config: WeChatDecryptConfig): SourceAdapter {
  return {
    id: "wechat-decrypt",
    async pull(sinceMs: number): Promise<NormalizedSession[]> {
      const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/sessions`);
      if (!res.ok) throw new Error(`wechat-decrypt 返回 ${res.status}`);
      const data = (await res.json()) as Array<{
        peer: string;
        messages: Array<{ id: string; sender: string; text: string; ts?: number }>;
      }>;
      return data
        .filter((s) => config.allowedPeers.includes(s.peer))
        .map((s) => {
          const messages = s.messages.map<Message>((m) => ({
            id: m.id,
            sender: m.sender === "self" ? "self" : "other",
            text: m.text,
            timestamp: m.ts == null ? null : String(m.ts),
            kind: "text",
          }));
          const latest = s.messages.reduce((mx, m) => Math.max(mx, m.ts ?? 0), 0);
          return { peer: s.peer, messages, latest };
        })
        .filter((s) => s.latest >= sinceMs)
        .map(({ peer, messages }) => ({ peer, messages }));
    },
  };
}
