// End-to-end check: the FULL crush-monitor pipeline (overview job -> six-dimension
// scoring, action choice, hard overrides) driven by the REAL local model behind
// the Laya JEV_STRICT service. Proves the local engine isn't just a wire stub.
//
// Usage:  npx tsx scripts/e2e-real.ts   (Laya service must be up on :8421)
import { analyze } from "../server/analysis";
import { overviewJob } from "../shared/incremental";
import type { LocalConfig } from "../server/model-config";
import type { Message } from "../shared/types";

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

// A short fictional exchange. Nothing real, nothing private.
const messages: Message[] = [
  { id: "a1", sender: "other", text: "今天加班好累", timestamp: null, kind: "text" },
  { id: "b1", sender: "self", text: "辛苦啦，早点休息", timestamp: null, kind: "text" },
  { id: "a2", sender: "other", text: "周末想去哪家店吃饭？", timestamp: null, kind: "text" },
  { id: "b2", sender: "self", text: "你定，我都行", timestamp: null, kind: "text" },
];

const request = overviewJob(messages, "crush", 1, {});
const result = await analyze(request, undefined, config);
const ov = result.overview!;
console.log("action:", ov.action);
console.log("stage:", ov.stage);
console.log("contextCount:", ov.contextCount);
console.log("affinityDimensions:", ov.affinityDimensions?.length);
console.log("emotions sample:", JSON.stringify(result.lines?.[0]?.emotions ?? {}).slice(0, 120));
console.log("OK: full pipeline ran against real local model");
