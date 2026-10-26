// IN -> THINK -> OUT end-to-end, driven by the zero-model stub decision server.
// Proves all three stages wire together without any real model or clipboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startStubDecisionServer } from "../tools/stub-decision-server";
import { runPipeline } from "../server/pipeline";
import { ACTIONS } from "../shared/types";
import type { LocalConfig } from "../server/model-config";
import type { Message } from "../shared/types";
import type { NormalizedSession, SourceAdapter } from "../shared/sources";

const sampleMessages: Message[] = [
  { id: "a1", sender: "other", text: "今天加班好累", timestamp: null, kind: "text" },
  { id: "b1", sender: "self", text: "辛苦啦，早点休息", timestamp: null, kind: "text" },
  { id: "a2", sender: "other", text: "周末想去哪家店吃饭？", timestamp: null, kind: "text" },
  { id: "b2", sender: "self", text: "你定，我都行", timestamp: null, kind: "text" },
];

function inlineSource(sessions: NormalizedSession[]): SourceAdapter {
  return {
    id: "inline",
    async pull() {
      return sessions;
    },
  };
}

test("pipeline runs IN->THINK->OUT without a model and delivers via print", async () => {
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
      source: inlineSource([{ peer: "小满", messages: sampleMessages }]),
      decisionConfig,
      deliverConfig: { mode: "print" },
      relation: "crush",
    });
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.peer, "小满");
    assert.ok(r.action in ACTIONS, `action ${r.action} should be a known action`);
    assert.match(r.text, /replysmith 建议/);
    assert.equal(r.delivered, false, "print mode must not mark as delivered");
  } finally {
    await stub.close();
  }
});

test("empty source yields no results and touches nothing", async () => {
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
      source: inlineSource([]),
      decisionConfig,
      deliverConfig: { mode: "print" },
    });
    assert.equal(results.length, 0);
  } finally {
    await stub.close();
  }
});

test("a dead chat model degrades to the strategy but reports why", async () => {
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
    const failures: string[] = [];
    const results = await runPipeline({
      source: inlineSource([{ peer: "小满", messages: sampleMessages }]),
      decisionConfig,
      deliverConfig: { mode: "print" },
      relation: "crush",
      // Nothing listens here: the draft must fail without killing the run.
      draft: {
        preset: "custom",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "dead",
        apiKey: "local",
        temperature: 0.7,
        maxTokens: 100,
        timeoutMs: 2000,
        wire: "openai",
      },
      onDraftError: (peer, message) => failures.push(`${peer}: ${message}`),
    });

    assert.equal(results.length, 1, "the session must still produce a result");
    assert.equal(results[0].drafted, false);
    assert.match(results[0].text, /replysmith 建议/, "falls back to the strategy");
    assert.equal(failures.length, 1, "the failure must surface, not vanish");
    assert.match(failures[0], /小满/);
  } finally {
    await stub.close();
  }
});
