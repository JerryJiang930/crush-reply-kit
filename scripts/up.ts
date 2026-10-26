// replysmith 一键启动：把三个本地部件当成一个前台进程组来管。
//
//   npx tsx scripts/up.ts     # 起判断模型 + 起草模型 + 网页，Ctrl+C 全收
//
// 上游 crush-monitor 的 npm start 只起一个 node 进程（判断模型在云端），所以
// Ctrl+C 就干净结束。我们多了两个本地守护进程，于是把它们收在同一个父进程下：
// 缺谁起谁、已经活着的不重复起、退出时只关自己起的那些。
// 这跟上游 package.json 里 concurrently -k 的语义一致：子进程随父进程一起死。
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { resolve, dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const projectRoot = resolve(repoRoot, ".."); // 放 .venv-laya 的上一层
const runtimeDir = resolve(repoRoot, ".runtime");

const env = (k: string, d = "") => (process.env[k] ?? d).trim();
const log = (m: string) => console.log(`[up] ${m}`);

const DECISION_PORT = Number(env("LOCAL_PORT", "8421"));
const CHAT_PORT = Number(env("CHAT_PORT", "11434"));

const OLLAMA_BIN = env(
  "OLLAMA_BIN",
  "C:/Users/jerry/.local/ollama/bin/ollama.exe",
);
const LAYA_PYTHON = env(
  "LAYA_PYTHON",
  resolve(projectRoot, ".venv-laya/Scripts/python.exe"),
);

const started: ChildProcess[] = [];

/**
 * 本地 HF 缓存里的 Laya 快照目录。
 *
 * 为什么不用 HF_HUB_OFFLINE 就够了：laya 加载时先做一次 snapshot_download，它只
 * 用离线标志挡下载、不挡元数据查询，网络一断（本机代理常返 502）启动就挂。
 * 把 multilingual 这个名字直接指到本地快照，加载器发现路径存在就完全不走网络。
 */
function findLayaSnapshot(): string | null {
  const explicit = env("LAYA_SNAPSHOT");
  if (explicit) return existsSync(explicit) ? explicit : null;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const snapshots = resolve(
    home,
    ".cache/huggingface/hub/models--convaiinnovations--laya/snapshots",
  );
  try {
    for (const name of readdirSync(snapshots)) {
      const dir = resolve(snapshots, name);
      if (existsSync(resolve(dir, "multilingual/rl_agent_config.json"))) {
        return dir;
      }
    }
  } catch {
    /* 缓存不存在就走 Hub 的老路 */
  }
  return null;
}

function logSink(name: string): number {
  mkdirSync(runtimeDir, { recursive: true });
  return openSync(resolve(runtimeDir, name), "a");
}

function portOpen(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((done) => {
    const sock = connect(port, "127.0.0.1");
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => {
      sock.destroy();
      done(true);
    });
    sock.on("error", () => {
      sock.destroy();
      done(false);
    });
    sock.on("timeout", () => {
      sock.destroy();
      done(false);
    });
  });
}

async function waitPort(
  name: string,
  port: number,
  seconds: number,
): Promise<boolean> {
  for (let i = 0; i < seconds; i++) {
    if (await portOpen(port)) {
      log(`${name} 就绪（${port}，约 ${i}s）`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(`${name} 在 ${seconds}s 内没起来（${port}），日志见 .runtime/`);
  return false;
}

/** Windows 上子进程常有自己的进程树，kill() 不够，用 taskkill /T 兜底。 */
function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
  } else {
    child.kill("SIGTERM");
  }
}

function stopAll(): void {
  if (started.length === 0) return;
  log(`关闭本次启动的 ${started.length} 个进程`);
  for (const c of started) stop(c);
  started.length = 0;
}

async function ensureDecisionService(): Promise<boolean> {
  if (await portOpen(DECISION_PORT)) {
    log(`判断服务已在 ${DECISION_PORT}，复用，不重复启动`);
    return true;
  }
  if (!existsSync(LAYA_PYTHON)) {
    log(`找不到 ${LAYA_PYTHON}，请先建 .venv-laya 或设 LAYA_PYTHON`);
    return false;
  }
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HF_HUB_OFFLINE: "1",
    HF_HUB_DISABLE_XET: "1",
    LAYA_JEV_STRICT: "1",
    LAYA_MODELS: "multilingual",
    LAYA_PRELOAD: "1",
    LAYA_TOURNAMENT_GROUP: "32",
    LAYA_HOST: "127.0.0.1",
    LAYA_PORT: String(DECISION_PORT),
    PYTHONUNBUFFERED: "1",
  };
  // 空的 HF_HOME 会被当成"没设"，直接摘掉，避免歧义。
  delete childEnv.HF_HOME;
  const snap = findLayaSnapshot();
  if (snap) {
    childEnv.LAYA_EXTRA_MODELS = JSON.stringify({
      multilingual: [snap, "multilingual"],
    });
    log(`权重走本地快照（不联网）：${snap}`);
  } else {
    log("没找到本地权重快照，启动时会去 Hub 查一次，网络不通会失败");
  }

  log("启动判断服务（Laya）…");
  const out = logSink("laya.log");
  const child = spawn(
    LAYA_PYTHON,
    ["-u", "-c", "from laya.serve import main; main()"],
    { cwd: projectRoot, stdio: ["ignore", out, out], env: childEnv },
  );
  child.on("error", (e) => log(`判断服务启动失败：${e.message}`));
  started.push(child);
  return waitPort("判断服务", DECISION_PORT, 120);
}

/**
 * llama-server only searches its own directory and the CWD when loading ggml
 * backends, but the GPU ones sit in a subdirectory (lib/ollama/cuda_v12 or
 * _v13). Without GGML_BACKEND_PATH it finds nothing, reports library=cpu, and a
 * 4.86GB Qwen3 then has to fit in RAM — dying with "llama-server process has
 * terminated: exit status 1" while /api/tags still answers 200, so the service
 * looks healthy and every draft silently fails.
 *
 * The variable must point at the .dll file, not the directory; the CUDA DLLs
 * also need their folder on PATH for cublas/cudart.
 */
function gpuEnv(binPath: string): Record<string, string> {
  const libRoot = join(dirname(binPath), "lib", "ollama");
  // Prefer the newest CUDA build present; Ollama ships several.
  const variants = ["cuda_v13", "cuda_v12"]
    .map((v) => join(libRoot, v))
    .filter((dir) => existsSync(join(dir, "ggml-cuda.dll")));
  const dir = variants[0];
  if (!dir) return {};
  return {
    GGML_BACKEND_PATH: join(dir, "ggml-cuda.dll"),
    PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
  };
}

async function ensureChatService(): Promise<boolean> {
  if (await portOpen(CHAT_PORT)) {
    log(`聊天模型已在 ${CHAT_PORT}，复用，不重复启动`);
    return true;
  }
  if (!existsSync(OLLAMA_BIN)) {
    log(`找不到 ${OLLAMA_BIN}，跳过聊天模型（草稿会用结构化建议兜底）`);
    return false;
  }
  log("启动聊天模型（Ollama serve）…");
  const gpu = gpuEnv(OLLAMA_BIN);
  if (gpu.GGML_BACKEND_PATH) {
    log(`  显卡后端：${gpu.GGML_BACKEND_PATH}`);
  } else {
    log("  没找到 CUDA 后端，会退回 CPU（慢且可能内存不足）");
  }
  const out = logSink("ollama.log");
  const child = spawn(OLLAMA_BIN, ["serve"], {
    cwd: dirname(OLLAMA_BIN),
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      ...gpu,
      OLLAMA_HOST: `127.0.0.1:${CHAT_PORT}`,
      OLLAMA_KEEP_ALIVE: "30m",
    },
  });
  child.on("error", (e) => log(`聊天模型启动失败：${e.message}`));
  started.push(child);
  return waitPort("聊天模型", CHAT_PORT, 60);
}

async function main(): Promise<void> {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      stopAll();
      process.exit(130);
    });
  }

  const decisionOk = await ensureDecisionService();
  const chatOk = await ensureChatService();

  if (!decisionOk) {
    console.error("[up] 判断服务没起来，THINK 无法进行。已退出。");
    stopAll();
    process.exit(1);
  }
  if (!chatOk) {
    log("聊天模型不可用：OUT 只给策略，不写具体句子");
  } else if (!env("DRAFT_PRESET") && !env("DRAFT_ENDPOINT") && !env("DRAFT_MODEL")) {
    // 聊天服务是本脚本起的或已在本机，没必要再让你手填一遍。
    process.env.DRAFT_PRESET = "ollama";
    log("未指定 DRAFT_*，默认用本机 Ollama（qwen3:8b）起草");
  }

  log("起网页 …\n");
  process.env.CRUSH_OPEN_BROWSER ??= "1";
  // 直接在当前进程里起，Ctrl+C 一次就能连同三个服务一起收掉。
  await import("../server/index");
}

main().catch((e) => {
  console.error("[up] 失败：", e instanceof Error ? e.message : e);
  stopAll();
  process.exit(1);
});
