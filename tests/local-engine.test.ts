// Proves the local decision engine seam is real: a stand-in server with no
// model behind it drives the untouched crush-monitor pipeline end to end,
// including the two guard rails that must survive every engine swap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../server/analysis";
import { ProviderError } from "../server/provider";
import { startStubDecisionServer, type StubGuide } from "../tools/stub-decision-server";
import type { LocalConfig } from "../server/model-config";
import type { AnalysisRequest, Message } from "../shared/types";
import { overviewJob } from "../shared/incremental";

const messages: Message[] = [
  { id: "a1", sender: "other", text: "今天加班好累", timestamp: null, kind: "text" },
  { id: "b1", sender: "self", text: "辛苦啦，早点休息", timestamp: null, kind: "text" },
  { id: "a2", sender: "other", text: "周末想去哪家店吃饭？", timestamp: null, kind: "text" },
  { id: "b2", sender: "self", text: "你定，我都行", timestamp: null, kind: "text" },
];

function localConfig(endpoint: string, extra?: Partial<LocalConfig>): LocalConfig {
  return {
    engine: "local",
    provider: "local-server",
    name: "本机判断服务",
    endpoint,
    model: "stub-decision-engine",
    apiKey: "local",
    protocol: "local",
    dialect: "systemone",
    ...extra,
  };
}

async function runOverview(guide: StubGuide, extra?: Partial<LocalConfig>) {
  const server = await startStubDecisionServer(guide);
  try {
    const request = overviewJob(messages, "crush", 1, {});
    const result = await analyze(request, undefined, localConfig(server.endpoint, extra));
    return result.overview!;
  } finally {
    await server.close();
  }
}

test("本地判断引擎可以驱动完整的 crush-monitor 流水线", async () => {
  const overview = await runOverview({ choices: { action: "invite" }, confidence: 0.9 });
  assert.equal(overview.action, "invite");
  assert.equal(overview.stage, "unknown");
  assert.equal(overview.contextCount, messages.length);
  assert.equal(overview.affinityDimensions?.length, 6);
});

test("boundary 硬覆盖：模型选了 invite，但对方明确拒绝 -> 强制 respect", async () => {
  const overview = await runOverview({
    choices: { action: "invite" },
    nouls: { boundary: 0.92 },
    confidence: 0.95,
  });
  assert.equal(overview.action, "respect");
  assert.equal(overview.boundaryApplied, true);
});

test("pending 硬覆盖：我方刚发出、球在对方手上 -> 强制 wait", async () => {
  const overview = await runOverview({
    choices: { action: "invite" },
    nouls: { boundary: 0.05, pending: 0.8 },
    confidence: 0.95,
  });
  assert.equal(overview.action, "wait");
});

test("置信度过低时宁可判 insufficient，也不硬给建议", async () => {
  const overview = await runOverview({
    choices: { action: "invite" },
    nouls: { boundary: 0, pending: 0 },
    confidence: 0.2,
  });
  assert.equal(overview.action, "insufficient");
});

test("分布不完整时被 validateResult 拦下，不会补造概率", async () => {
  const server = await startStubDecisionServer({ confidence: 0.9, drop: "wait" });
  try {
    const request = overviewJob(messages, "crush", 1, {});
    await assert.rejects(
      () => analyze(request, undefined, localConfig(server.endpoint)),
      (error: unknown) =>
        error instanceof ProviderError && error.status === 502,
    );
  } finally {
    await server.close();
  }
});

test("连不上本地服务时报出可诊断的错误，而不是静默降级", async () => {
  const request = overviewJob(messages, "crush", 1, {});
  await assert.rejects(
    () => analyze(request, undefined, localConfig("http://127.0.0.1:1")),
    (error: unknown) => error instanceof ProviderError,
  );
});

test("逐句任务同样走本地引擎：情绪与意图能解码出来", async () => {
  const server = await startStubDecisionServer({ confidence: 0.8 });
  try {
    const request: AnalysisRequest = {
      revision: 1,
      relation: "crush",
      task: "other_messages",
      targetIds: ["a1", "a2"],
      messages,
    };
    const result = await analyze(request, undefined, localConfig(server.endpoint));
    assert.equal(result.lines?.length, 2);
    const first = result.lines!.find((l) => l.id === "a1")!;
    assert.ok(Object.keys(first.emotions ?? {}).length > 0);
    assert.ok(Object.keys(first.intents ?? {}).length > 0);
  } finally {
    await server.close();
  }
});

test("我方回复评级：拿不到未来消息是结构保证的", async () => {
  const server = await startStubDecisionServer({
    confidence: 0.9,
    scores: { b1_score: 4 },
  });
  try {
    const request: AnalysisRequest = {
      revision: 1,
      relation: "crush",
      task: "self_message",
      targetIds: ["b1"],
      messages,
    };
    const result = await analyze(request, undefined, localConfig(server.endpoint));
    const line = result.lines!.find((l) => l.id === "b1")!;
    assert.equal(line.score.value, 100);
    assert.equal(line.score.status, "clear");
  } finally {
    await server.close();
  }
});
