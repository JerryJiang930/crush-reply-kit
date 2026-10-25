// OUT stage: deliver the suggested reply to the user.
//
// The only thing that leaves our process is the *suggested text* — never the
// raw chat. Default behaviour is clipboard copy; the user pastes it themselves.
// We deliberately do NOT auto-paste into WeChat: that removes the one human
// confirmation point and is brittle against WeChat version changes.
//
// Everything is configurable; nothing about a model or a peer is hardcoded.
import { spawn } from "node:child_process";

export type DeliverConfig = {
  /** "clipboard" copies the text; "print" just logs it (dry run / CI). */
  mode: "clipboard" | "print";
};

export class DeliverError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Copy `text` to the system clipboard. On Windows uses `clip.exe`; on other
 * platforms falls back to `pbcopy` / `xclip` if available. Returns true if the
 * copy actually happened.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (process.platform === "win32") {
    await runClip(["clip"], text);
    return true;
  }
  if (process.platform === "darwin") {
    await runClip(["pbcopy"], text);
    return true;
  }
  // Linux: best effort, not fatal if missing.
  try {
    await runClip(["xclip", "-selection", "clipboard"], text);
    return true;
  } catch {
    return false;
  }
}

function runClip(args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new DeliverError(`clipboard tool exited ${code}`))));
    child.stdin!.end(text);
  });
}

/**
 * Deliver according to config. In "print" mode nothing leaves the process —
 * this is what tests and CI use.
 */
export async function deliver(text: string, config: DeliverConfig): Promise<{ delivered: boolean }> {
  if (config.mode === "print") {
    // eslint-disable-next-line no-console
    console.log("[replysmith] suggestion:\n" + text);
    return { delivered: false };
  }
  const delivered = await copyToClipboard(text);
  if (!delivered) throw new DeliverError("剪贴板写入失败 / clipboard write failed");
  return { delivered };
}
