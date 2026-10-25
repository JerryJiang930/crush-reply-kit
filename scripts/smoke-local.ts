// Smoke test for the local decision engine seam against a REAL backend
// (e.g. Laya running in JEV_STRICT mode at http://127.0.0.1:8421).
//
// This proves the one thing the stub tests can't: that a live local model
// answers a SystemOneRequest through our `evaluate()` adapter and survives
// validateResult's five invariants. It does NOT touch the crush-monitor
// full pipeline — that's covered by tests/local-engine.test.ts once the
// backend is reachable.
//
// Usage:
//   1. start the backend (see PROJECT.md §9)
//   2. npx tsx scripts/smoke-local.ts
import { evaluate } from "../server/provider";
import type { LocalConfig } from "../server/model-config";
import type { Questions, SystemOneRequest } from "@typesafe-ai/sdk";

const config: LocalConfig = {
  engine: "local",
  provider: "laya",
  name: "Laya (local)",
  endpoint: process.env.LOCAL_ENDPOINT || "http://127.0.0.1:8421",
  model: process.env.LOCAL_MODEL || "convaiinnovations/laya-multilingual",
  apiKey: "local",
  protocol: "local",
  dialect: "systemone",
};

const questions: Questions = {
  action: {
    type: "choice",
    instructions: "下一步我方最合适的策略",
    criteria: {
      continue: "顺着聊",
      ask: "轻轻追问",
      hold: "先接情绪",
      flirt: "轻轻调情",
      invite: "试着约一下",
      clarify: "直接问清",
      wait: "等对方接球",
      end: "今天先收尾",
      respect: "尊重边界",
      insufficient: "无法建议",
    },
  },
  boundary: {
    type: "noul",
    instructions: "对方是否明确表达过拒绝或边界",
  },
  pending: {
    type: "noul",
    instructions: "是否球已递出、在等对方回应",
  },
};

const payload: SystemOneRequest<Questions> = {
  state:
    "对方：今天加班好累。我：辛苦啦，早点休息。对方：周末想去哪家店吃饭？",
  questions,
};

const result = await evaluate(payload, undefined, config);
console.log("model:", result.model);
console.log("usage:", result.usage);
console.log("answers:", JSON.stringify(result.answers, null, 2));
