// 每个人一个小文件，记两件事：上次读到哪条消息（游标），以及「对方是谁」（设定）。
//
// 分开存而不是塞进库里的原因：这些东西是工具的私有状态，不该混进聊天数据；
// 而放 localStorage 又换个浏览器就没了。一个人一个文件最好查，删掉就是从头来。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile, SessionReport } from "../shared/pipeline-types";

const here = dirname(fileURLToPath(import.meta.url));
export const peersDir = resolve(here, "..", ".runtime", "peers");

export type PeerState = {
  /** 稳定 key（wxid），昵称改了也不影响。 */
  peer: string;
  /** 上次看到的昵称，只用来显示。 */
  name?: string;
  lastMs: number;
  count: number;
  at: string;
  profile?: Profile;
};

function safeName(peer: string): string {
  return peer.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "unknown";
}

function stateFile(peer: string): string {
  return join(peersDir, `${safeName(peer)}.json`);
}

/** 更早对话的摘要单独一个文件，和游标分开，清游标不会连带丢掉摘要。 */
export function summaryStore(peer: string): {
  read(): string | null;
  write(text: string, upToId: string): void;
} {
  const file = join(peersDir, `${safeName(peer)}.summary.json`);
  return {
    read() {
      try {
        if (!existsSync(file)) return null;
        const raw = JSON.parse(readFileSync(file, "utf8")) as { text?: string };
        return raw.text?.trim() || null;
      } catch {
        return null;
      }
    },
    write(text, upToId) {
      try {
        mkdirSync(peersDir, { recursive: true });
        writeFileSync(
          file,
          JSON.stringify({ text, upToId, at: new Date().toISOString() }),
        );
      } catch {
        /* 摘要丢了下次重算，不影响这一轮 */
      }
    },
  };
}

export function readPeerState(peer: string): PeerState | null {
  try {
    const f = stateFile(peer);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8")) as PeerState;
  } catch {
    return null;
  }
}

/** 合并写，不覆盖没传的字段。写不出来不算错误，游标和设定都只是优化。 */
export function writePeerState(peer: string, patch: Partial<PeerState>): void {
  try {
    mkdirSync(peersDir, { recursive: true });
    const prev = readPeerState(peer);
    const next: PeerState = {
      peer,
      lastMs: patch.lastMs ?? prev?.lastMs ?? 0,
      count: patch.count ?? prev?.count ?? 0,
      at: new Date().toISOString(),
      ...(patch.name ?? prev?.name ? { name: patch.name ?? prev?.name } : {}),
      ...(patch.profile ?? prev?.profile ? { profile: patch.profile ?? prev?.profile } : {}),
    };
    writeFileSync(stateFile(peer), JSON.stringify(next));
  } catch {
    /* 只是本地缓存，失败不影响本次分析 */
  }
}

/**
 * 每个人最近一次的分析单独一个文件。存下来是为了点回这个人能直接看上次的判断，
 * 不用为了看结果再点一次「开始」重跑。这里只做本地缓存，删掉就是下次重跑。
 */
export type PeerReportFile = {
  at: number;
  relation?: string;
  reports: SessionReport[];
};

function reportFile(peer: string): string {
  return join(peersDir, `${safeName(peer)}.report.json`);
}

export function readPeerReport(peer: string): PeerReportFile | null {
  try {
    const f = reportFile(peer);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8")) as PeerReportFile;
  } catch {
    return null;
  }
}

export function writePeerReport(peer: string, data: PeerReportFile): void {
  try {
    mkdirSync(peersDir, { recursive: true });
    writeFileSync(reportFile(peer), JSON.stringify(data));
  } catch {
    /* 存不下只是下次要重跑，不影响这次结果 */
  }
}

/** 所有存过状态的人，最近活跃的排前面。 */
export function listKnownPeers(): PeerState[] {
  try {
    if (!existsSync(peersDir)) return [];
    return readdirSync(peersDir)
      // 摘要和报告是同一个人的另外两个文件，不是「一个人」，别混进来。
      .filter(
        (f) =>
          f.endsWith(".json") &&
          !f.endsWith(".summary.json") &&
          !f.endsWith(".report.json"),
      )
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(peersDir, f), "utf8")) as PeerState;
        } catch {
          return null;
        }
      })
      .filter((s): s is PeerState => !!s)
      .sort((a, b) => b.lastMs - a.lastMs);
  } catch {
    return [];
  }
}
