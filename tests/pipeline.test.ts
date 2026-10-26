// IN -> THINK -> OUT end-to-end, driven by the zero-model stub decision server.
//
// The point of these tests is the *shape* of what THINK produces. It is easy to
// keep only `overview.action` and still have a green pipeline while the report
// has lost every number that made it worth reading, so the assertions below
// pin the per-message judgments and the several reply directions, not just the
// verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startStubDecisionServer } from "../tools/stub-decision-server";
import { runPipeline } from "../server/pipeline";
import { renderCandidates, renderReport } from "../server/report";
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

function stubConfig(endpoint: string): LocalConfig {
  return {
    engine: "local",
    provider: "stub",
    name: "stub",
    endpoint,
    model: "stub-decision-engine",
    apiKey: "local",
    protocol: "local",
    dialect: "systemone",
  };
}

test("THINK returns the relationship reading and the per-message one", async () => {
  const stub = await startStubDecisionServer();
  try {
    const reports = await runPipeline({
      source: inlineSource([{ peer: "小满", messages: sampleMessages }]),
      decisionConfig: stubConfig(stub.endpoint),
      relation: "crush",
    });
    assert.equal(reports.length, 1);
    const r = reports[0];

    // The verdict.
    assert.equal(r.peer, "小满");
    assert.ok(r.overview, "overview must survive");
    assert.ok(r.overview!.action in ACTIONS, `unknown action ${r.overview!.action}`);
    assert.ok(
      r.overview!.affinityDimensions?.length,
      "affinity must keep its five weighted dimensions",
    );

    // The evidence behind it: every line in the window got judged.
    assert.equal(r.lines.length, sampleMessages.length, "every message must be judged");
    const other = r.lines.filter((l) => l.emotions);
    assert.equal(other.length, 2, "both messages from the other side carry emotions");
    assert.ok(Object.keys(other[0].intents ?? {}).length > 1, "intents too");
    const self = r.lines.filter((l) => l.score.value !== null);
    assert.equal(self.length, 2, "your replies carry an expression-quality score");
  } finally {
    await stub.close();
  }
});

test("OUT offers more than one direction, and they are different", async () => {
  const stub = await startStubDecisionServer();
  try {
    const [r] = await runPipeline({
      source: inlineSource([{ peer: "小满", messages: sampleMessages }]),
      decisionConfig: stubConfig(stub.endpoint),
      relation: "crush",
    });
    assert.ok(r.candidates.length >= 2, "a single candidate is an auto-reply, not advice");
    const actions = r.candidates.map((c) => c.action);
    assert.equal(new Set(actions).size, actions.length, "directions must not repeat");
    for (const c of r.candidates) {
      assert.ok(c.label.length > 0);
      assert.ok(c.detail.length > 0);
    }
    // No chat model configured: strategy only, and that is fine.
    assert.equal(r.candidates.every((c) => c.text === null), true);
  } finally {
    await stub.close();
  }
});

test("a stated boundary collapses the menu to respect", async () => {
  // noul >= 0.8 on the boundary question means the other side said stop.
  const stub = await startStubDecisionServer({ nouls: { boundary: 0.95 } });
  try {
    const [r] = await runPipeline({
      source: inlineSource([{ peer: "阿哲", messages: sampleMessages }]),
      decisionConfig: stubConfig(stub.endpoint),
      relation: "crush",
    });
    assert.equal(r.overview!.boundaryApplied, true);
    assert.equal(r.overview!.action, "respect");
    assert.equal(r.candidates.length, 1, "no alternatives when the answer is stop");
    assert.equal(r.candidates[0].action, "respect");
  } finally {
    await stub.close();
  }
});

test("renderReport prints the numbers, not just the verdict", async () => {
  const stub = await startStubDecisionServer();
  try {
    const [r] = await runPipeline({
      source: inlineSource([{ peer: "小满", messages: sampleMessages }]),
      decisionConfig: stubConfig(stub.endpoint),
      relation: "crush",
    });
    const out = renderReport(r);
    assert.match(out, /好感度/);
    assert.match(out, /阶段/);
    assert.match(out, /逐句/);
    assert.match(out, /情绪/);
    assert.match(out, /意图/);
    assert.match(out, /下一步/);
    assert.match(out, /小满/);

    const list = renderCandidates(r.candidates);
    assert.match(list, /候选/);
    assert.match(list, /1/);
  } finally {
    await stub.close();
  }
});

test("empty source yields no results and touches nothing", async () => {
  const stub = await startStubDecisionServer();
  try {
    const reports = await runPipeline({
      source: inlineSource([]),
      decisionConfig: stubConfig(stub.endpoint),
    });
    assert.equal(reports.length, 0);
  } finally {
    await stub.close();
  }
});

test("a dead chat model keeps the directions and says why", async () => {
  const stub = await startStubDecisionServer();
  try {
    const failures: string[] = [];
    const reports = await runPipeline({
      source: inlineSource([{ peer: "小满", messages: sampleMessages }]),
      decisionConfig: stubConfig(stub.endpoint),
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
      onDraftError: (peer, action, message) => failures.push(`${peer}/${action}: ${message}`),
    });

    assert.equal(reports.length, 1, "the session must still produce a report");
    assert.ok(reports[0].overview, "the judgment is unaffected by a dead chat model");
    assert.ok(reports[0].candidates.length >= 2, "directions survive");
    assert.equal(reports[0].candidates.every((c) => c.text === null), true);
    assert.ok(failures.length >= 1, "the failure must surface, not vanish");
    assert.match(failures[0], /小满/);
  } finally {
    await stub.close();
  }
});
