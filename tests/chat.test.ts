// Locks the chat-model seam: reasoning stripping, config resolution, and the
// guarantee that a dead draft endpoint degrades to a structured suggestion
// instead of breaking the pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatComplete, listChatModels, stripReasoning } from "../server/chat-client";
import {
  normalizeChatConfig,
  readChatConfigFile,
  resolveChatConfig,
} from "../server/chat-config";
import { buildDraftPrompt, runPipeline } from "../server/pipeline";
import { startStubDecisionServer } from "../tools/stub-decision-server";
import type { LocalConfig } from "../server/model-config";

test("stripReasoning drops the Qwen3 thinking block", () => {
  assert.equal(
    stripReasoning("<｜end▁of▁thinking｜>早点睡吧，明天别硬撑。"),
    "早点睡吧，明天别硬撑。",
  );
  assert.equal(
    stripReasoning("<｜end▁of▁thinking｜>那就明天见。"),
    "那就明天见。",
  );
  // Unclosed opener = the model was cut off mid-thought. Nothing usable.
  assert.equal(stripReasoning(" thinking\n正在想该怎么回"), "");
  // Plain text with no tags passes through untouched.
  assert.equal(stripReasoning("早点休息"), "早点休息");
});

test("stripReasoning unwraps fences and stray quotes", () => {
  assert.equal(stripReasoning("```\n早点休息\n```"), "早点休息");
  assert.equal(stripReasoning("“早点休息”"), "早点休息");
  assert.equal(stripReasoning("「早点休息」"), "早点休息");
});

test("normalizeChatConfig fills blanks from a preset", () => {
  const c = normalizeChatConfig({ preset: "ollama" });
  assert.equal(c.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(c.model, "qwen3:8b");
  assert.equal(c.apiKey, "local");
  // Ollama's compatible route ignores think:false, so the preset must opt into
  // the native shape or Qwen3 answers with an empty string.
  assert.equal(c.wire, "ollama");
});

test("normalizeChatConfig defaults to the standard OpenAI wire", () => {
  assert.equal(normalizeChatConfig({ preset: "deepseek", apiKey: "k" }).wire, "openai");
  assert.equal(
    normalizeChatConfig({ baseUrl: "http://127.0.0.1:9000/v1", model: "m" }).wire,
    "openai",
  );
});

/** A throwaway Ollama-native server: /api/tags + /api/chat. */
async function startFakeOllama(reply: string): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { think?: boolean };
      // The whole point of this route: think must be explicitly false.
      assert.equal(parsed.think, false);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "qwen3:8b",
          message: { content: reply },
          prompt_eval_count: 27,
          eval_count: 14,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}/v1` };
}

test("ollama wire talks to /api/chat with thinking off", async () => {
  const { server, base } = await startFakeOllama("今天辛苦了，早点睡。");
  try {
    const cfg = normalizeChatConfig({ preset: "ollama", baseUrl: base });
    assert.equal(cfg.wire, "ollama");
    const out = await chatComplete(cfg, [{ role: "user", content: "hi" }]);
    assert.equal(out.text, "今天辛苦了，早点睡。");
    assert.equal(out.usage?.completion, 14);
    assert.equal((await listChatModels(cfg))[0], "qwen3:8b");
  } finally {
    server.close();
  }
});

test("normalizeChatConfig rejects plaintext HTTP to a remote host", () => {
  assert.throws(
    () => normalizeChatConfig({ baseUrl: "http://example.com/v1", model: "x" }),
    /HTTPS/,
  );
});

test("normalizeChatConfig requires a key for hosted presets", () => {
  assert.throws(() => normalizeChatConfig({ preset: "deepseek" }), /API Key/);
});

test("resolveChatConfig returns null when nothing is configured", () => {
  const dir = mkdtempSync(join(tmpdir(), "replysmith-chat-"));
  assert.equal(readChatConfigFile(join(dir, "nope.json")), null);
  // Point both sources at emptiness.
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("DRAFT_")) delete process.env[k];
  try {
    assert.equal(resolveChatConfig(join(dir, "nope.json")), null);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("resolveChatConfig lets env override the file per field", () => {
  const dir = mkdtempSync(join(tmpdir(), "replysmith-chat-"));
  const file = join(dir, "chat.json");
  writeFileSync(file, JSON.stringify({ preset: "ollama", model: "qwen3:4b" }));
  const saved = process.env.DRAFT_MODEL;
  process.env.DRAFT_MODEL = "qwen3:8b";
  try {
    const c = resolveChatConfig(file);
    assert.equal(c?.model, "qwen3:8b", "env wins");
    assert.equal(c?.baseUrl, "http://127.0.0.1:11434/v1", "file/preset fills the rest");
  } finally {
    if (saved === undefined) delete process.env.DRAFT_MODEL;
    else process.env.DRAFT_MODEL = saved;
  }
});

test("buildDraftPrompt carries the chosen strategy", () => {
  const p = buildDraftPrompt(
    { action: "respect", stage: "dating" } as never,
    "我：在吗\n对方：最近有点忙",
  );
  assert.match(p.system, /只输出这句话本身/);
  assert.match(p.user, /对方：最近有点忙/);
  assert.match(p.user, /策略/);
});

/** A throwaway OpenAI-compatible server that returns one fixed sentence. */
async function startFakeChat(reply: string): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake-8b" }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        model: "fake-8b",
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 42, completion_tokens: 8 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}/v1` };
}

test("chatComplete parses an OpenAI-shaped response", async () => {
  const { server, base } = await startFakeChat("<｜end▁of▁thinking｜>那你先忙，晚点再说。");
  try {
    const cfg = normalizeChatConfig({ baseUrl: base, model: "fake-8b" });
    const out = await chatComplete(cfg, [{ role: "user", content: "hi" }]);
    assert.equal(out.text, "那你先忙，晚点再说。");
    assert.equal(out.model, "fake-8b");
    assert.equal(out.usage?.completion, 8);
    assert.equal((await listChatModels(cfg, fetch))[0], "fake-8b");
  } finally {
    server.close();
  }
});

test("pipeline uses the draft text and keeps the strategy out of it", async () => {
  const stub = await startStubDecisionServer();
  const { server, base } = await startFakeChat("<｜end▁of▁thinking｜>那你先忙，晚点再说。");
  try {
    const decisionConfig: LocalConfig = {
      engine: "local",
      provider: "stub",
      name: "stub",
      endpoint: stub.endpoint,
      model: "stub-decision-engine",
      apiKey: "local",
      protocol: "local",
      dialect: "systemone",
    };
    const results = await runPipeline({
      source: {
        id: "inline",
        async pull() {
          return [
            {
              peer: "小满",
              messages: [
                { id: "1", sender: "other" as const, text: "最近有点忙", timestamp: null, kind: "text" as const },
                { id: "2", sender: "self" as const, text: "在吗", timestamp: null, kind: "text" as const },
              ],
            },
          ];
        },
      },
      decisionConfig,
      deliverConfig: { mode: "print" },
      draft: normalizeChatConfig({ baseUrl: base, model: "fake-8b" }),
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].drafted, true);
    assert.equal(results[0].text, "那你先忙，晚点再说。");
    assert.ok(!results[0].text.includes("策略"), "paste must stay clean");
    assert.match(results[0].strategy, /——/);
  } finally {
    server.close();
    await stub.close();
  }
});

test("pipeline falls back to the structured suggestion when the draft model is down", async () => {
  const stub = await startStubDecisionServer();
  try {
    const decisionConfig: LocalConfig = {
      engine: "local",
      provider: "stub",
      name: "stub",
      endpoint: stub.endpoint,
      model: "stub-decision-engine",
      apiKey: "local",
      protocol: "local",
      dialect: "systemone",
    };
    const results = await runPipeline({
      source: {
        id: "inline",
        async pull() {
          return [
            {
              peer: "阿哲",
              messages: [
                { id: "1", sender: "other" as const, text: "没事，你先忙", timestamp: null, kind: "text" as const },
              ],
            },
          ];
        },
      },
      decisionConfig,
      deliverConfig: { mode: "print" },
      // Port 1 is never listening.
      draft: normalizeChatConfig({ baseUrl: "http://127.0.0.1:1/v1", model: "gone", timeoutMs: 2000 }),
    });
    assert.equal(results[0].drafted, false);
    assert.match(results[0].text, /replysmith 建议/);
  } finally {
    await stub.close();
  }
});
