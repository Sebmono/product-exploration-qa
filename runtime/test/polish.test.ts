import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { performHandoff, polishWorkOrder, EXEMPLAR_PROMPT } from "../src/compile/handoff.js";
import { compileWorkOrder } from "../src/compile/work-order.js";
import { FileHandoffSink, WebhookHandoffSink } from "../src/handoff/sink.js";
import { readTrace } from "../src/trace/reader.js";
import { TraceWriter } from "../src/trace/writer.js";
import { writeNewWorkRequestFixture } from "../src/trace/fixture-new-work-request.js";
import type { LLM } from "../src/agent/loop.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pw-polish-"));

const POLISHED = `Create new documentation: a how-to guide explaining how to kick off a New Work Request in the demo app's web UI. Place it in the guides/ directory as a new markdown file (guides/creating-a-work-request.md).

Cover, in order: (1) the Create Work Request button in the left navigation — visible only with write access; (2) the two fields and their gating; (3) what happens on submit.

Audience: an end user brand new to the app. Format: one short intro paragraph, then numbered steps. Keep it under ~120 lines.`;

function textLLM(text: string, capture?: { system?: string; user?: string }): LLM {
  return {
    create: async (p) => {
      if (capture) {
        capture.system = String(p.system ?? "");
        const first = p.messages[0];
        capture.user = typeof first?.content === "string" ? first.content : "";
      }
      return {
        id: "m", type: "message", role: "assistant", model: "mock",
        content: [{ type: "text", text, citations: [] }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } as Anthropic.Usage,
      } as Anthropic.Message;
    },
  };
}

function mockSink(status = 200, body: unknown = { id: "wo-42" }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const sink = new WebhookHandoffSink({
    url: "https://handoff.test/hooks/work-orders",
    token: "k-test-1234",
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
  });
  return { sink, calls };
}

describe("polishWorkOrder", () => {
  const events = readTrace(writeNewWorkRequestFixture(tmp()).tracePath);
  const order = compileWorkOrder(events);

  it("feeds the exemplar + facts to the LLM and returns the polished prompt", async () => {
    const capture: { system?: string; user?: string } = {};
    const out = await polishWorkOrder(order, { llm: textLLM(POLISHED, capture), model: "mock" });
    expect(out).toBe(POLISHED);
    expect(capture.system).toContain(EXEMPLAR_PROMPT.slice(0, 60)); // exemplar is the quality bar
    expect(capture.user).toContain("verified by direct exploration"); // grounded in trace facts
  });

  it("falls back to the deterministic draft when the polish loses the plot", async () => {
    const out = await polishWorkOrder(order, { llm: textLLM("Sure! Here's a prompt idea:"), model: "mock" });
    expect(out).toBe(order.prompt);
  });
});

describe("performHandoff", () => {
  const root = tmp();
  const events = readTrace(writeNewWorkRequestFixture(root).tracePath);

  it("compiles, polishes, submits, and appends artifact + handoff trace events", async () => {
    const { sink, calls } = mockSink();
    const trace = new TraceWriter({ runsRoot: root, runId: "handoff-test" });
    const result = await performHandoff({
      events, publication: "Product Exploration Test", sink,
      model: "mock", llm: textLLM(POLISHED), trace,
    });
    expect(result).toMatchObject({ submitted: true, workOrderId: "wo-42", prompt: POLISHED });
    expect(calls[0]!.url).toContain("/hooks/work-orders");
    expect(calls[0]!.body).toMatchObject({ publication: "Product Exploration Test", body: POLISHED });
    const types = readTrace(trace.tracePath).map((e) => e.type);
    expect(types).toEqual(["artifact", "handoff"]);
  });

  it("dry-run polishes but never reaches the sink", async () => {
    const { sink, calls } = mockSink();
    const result = await performHandoff({
      events, publication: "X", sink, model: "mock", llm: textLLM(POLISHED), dryRun: true,
    });
    expect(result.submitted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("writes the work order to disk through the default file sink", async () => {
    const dir = join(root, "handoffs");
    const result = await performHandoff({
      events, publication: "Product Exploration Test", sink: new FileHandoffSink({ dir }),
      model: "mock", llm: textLLM(POLISHED),
    });
    expect(result).toMatchObject({ submitted: true, prompt: POLISHED });
    expect(result.ref).toContain(dir);
  });

  it("ships the deterministic draft when no LLM is available", async () => {
    const { sink } = mockSink();
    const result = await performHandoff({ events, publication: "X", sink, model: "mock", dryRun: true });
    expect(result.prompt).toContain("verified by direct exploration");
  });
});
