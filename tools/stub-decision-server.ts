// A local stand-in for the decision engine, used to exercise the whole
// pipeline without any model and without spending a cent.
//
// It speaks the same wire shape as TypeSafe's POST /v1/systemone, so the
// TypeScript side cannot tell it apart from a real local engine. Every answer
// it returns satisfies the invariants validateResult() checks.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type StubGuide = {
  /** question id -> exact key to pick */
  choices?: Record<string, string>;
  /** question id -> noul probability */
  nouls?: Record<string, number>;
  /** question id -> score level (float, within 0..levels-1) */
  scores?: Record<string, number>;
  /** how peaked the distribution is; 0..1 */
  confidence?: number;
  /** omit a key from every distribution - used to prove validation rejects it */
  drop?: string;
};

type Question = {
  type: "choice" | "score" | "noul";
  instructions?: string;
  criteria?: unknown;
};

function criteriaKeys(question: Question): string[] {
  const c = question.criteria as unknown;
  if (Array.isArray(c)) return c.map((_, i) => String(i));
  if (c && typeof c === "object") return Object.keys(c as Record<string, unknown>);
  return [];
}

/**
 * Build a distribution over exactly the declared keys, normalised so it sums
 * to 1. precision is fine-grained deliberately: rounding every option to two
 * decimals makes large choice sets (the 200-item evidence list) sum to 0.
 */
function distribution(keys: string[], chosen: string, confidence: number, drop?: string) {
  if (!keys.length) throw new Error("question has no criteria keys");
  const target = keys.includes(chosen) ? chosen : keys[0];
  const others = keys.filter((k) => k !== target);
  const peak = Math.min(0.999, Math.max(1 / keys.length, confidence));
  const rest = (1 - peak) / Math.max(1, others.length);
  const weights = new Map<string, number>();
  for (const k of keys) weights.set(k, k === target ? peak : rest);
  if (drop) weights.delete(drop);
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const probabilities: Record<string, number> = {};
  for (const [k, v] of weights) probabilities[k] = v / total;
  return { probabilities, target };
}

function answerFor(id: string, question: Question, guide: StubGuide) {
  const keys = criteriaKeys(question);
  const confidence = guide.confidence ?? 0.9;
  const peak = Math.min(0.99, confidence);

  if (question.type === "noul") {
    const value = guide.nouls?.[id];
    return {
      type: "noul" as const,
      noul: Math.min(1, Math.max(0, typeof value === "number" ? value : 0)),
    };
  }
  if (question.type === "score") {
    const levels = keys.length;
    const requested = guide.scores?.[id];
    const score =
      typeof requested === "number"
        ? Math.min(levels - 1, Math.max(0, requested))
        : Math.round((levels - 1) / 2);
    const { probabilities } = distribution(
      keys,
      String(Math.round(score)),
      peak,
      guide.drop,
    );
    return {
      type: "score" as const,
      score,
      confidence: peak,
      probabilities,
    };
  }
  const wanted = guide.choices?.[id] ?? keys[0];
  const { probabilities, target } = distribution(keys, wanted, peak, guide.drop);
  return {
    type: "choice" as const,
    choice: target,
    confidence: peak,
    probabilities,
  };
}

export type StubServer = {
  endpoint: string;
  close: () => Promise<void>;
};

export async function startStubDecisionServer(guide: StubGuide = {}): Promise<StubServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: { model?: string; questions?: Record<string, Question> };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end("{}");
        return;
      }
      const questions = body.questions ?? {};
      const answers: Record<string, unknown> = {};
      try {
        for (const [id, question] of Object.entries(questions))
          answers[id] = answerFor(id, question, guide);
      } catch (error) {
        res.writeHead(500).end(JSON.stringify({ error: (error as Error).message }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          model: body.model || "stub-decision-engine",
          answers,
          usage: { input_tokens: 128, output_tokens: 0 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    }),
  };
}
