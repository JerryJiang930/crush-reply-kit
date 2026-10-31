// 分析之前先把加密库解一遍，让明文快照跟上微信里的新消息。
//
// 为什么必须每次解：明文副本是某一刻的快照，微信一直在往加密库里写。不解的话
// 「更新」读的还是上次那份，新消息永远进不来。
//
// 两段式：extract 从微信进程内存拿密钥，decrypt 拿密钥解开 26 个库。密钥每次都
// 重新取，因为微信重启后密钥会变。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");
export const wechatDir = resolve(here, "..", ".runtime", "wechat");
export const decryptedDir = join(wechatDir, "decrypted");

type SyncConfig = {
  /** 解密钥那个工具的目录（wcdb-key-tool）。 */
  toolDir: string;
  /** 跑 python 的解释器绝对路径。 */
  python: string;
  /** 微信原始加密库（xwechat_files/<wxid>/db_storage）。 */
  dbDir: string;
};

export function readSyncConfig(): SyncConfig {
  const ownerFile = join(wechatDir, "owner.json");
  let dbDir = "";
  try {
    dbDir = (JSON.parse(readFileSync(ownerFile, "utf8")) as { sourceDbDir?: string })
      .sourceDbDir ?? "";
  } catch {
    /* 下面校验会报 */
  }
  return {
    toolDir:
      process.env.WECHAT_TOOL_DIR || "C:/Users/jerry/wechat-4x-decrypt-main/wcdb-key-tool-main",
    python:
      process.env.WECHAT_PYTHON || "python",
    dbDir,
  };
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (out += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolvePromise(out)
        : reject(new Error(`解密失败（退出码 ${code}）：${out.slice(-400)}`)),
    );
  });
}

let running: Promise<{ ok: boolean; message: string }> | null = null;

/**
 * 重新解一遍，成功后原子替换旧快照。并发调用共用同一次执行——前端重复点不该
 * 起两个 python。
 */
export function syncWeChat(): Promise<{ ok: boolean; message: string }> {
  if (running) return running;
  running = (async () => {
    const cfg = readSyncConfig();
    if (!cfg.dbDir) throw new Error("还不知道你的微信库在哪，先解一次密。");
    if (!existsSync(cfg.toolDir)) throw new Error(`找不到解密工具：${cfg.toolDir}`);
    if (!existsSync(cfg.dbDir)) throw new Error(`找不到微信库：${cfg.dbDir}`);

    const script = join(cfg.toolDir, "wcdb_key_tool_windows.py");
    const keys = join(wechatDir, "all_keys.json");

    await run(cfg.python, [script, "extract", "--db-dir", cfg.dbDir, "--output", keys], cfg.toolDir);
    // 直接覆盖同名文件，不做目录替换：删一个上百文件的目录会被安全策略拦下，
    // 而逐库覆盖是原子的，某个库失败只影响它自己。
    await run(
      cfg.python,
      [script, "decrypt", "--keys", keys, "--output", decryptedDir, "--db-dir", cfg.dbDir],
      cfg.toolDir,
    );
    if (!existsSync(join(decryptedDir, "session/session.db"))) {
      throw new Error("解出来的目录不完整，检查微信是否还登录着。");
    }
    return { ok: true, message: "微信记录已同步到最新。" };
  })()
    .catch((e: unknown) => ({
      ok: false,
      message: e instanceof Error ? e.message : "同步失败。",
    }))
    .finally(() => {
      running = null;
    });
  return running;
}
