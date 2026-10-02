import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { checkAction, defaultPolicy, labelForRef } from "../src/agent/guardrails.js";
import { readRepoFile, repoOverview, searchRepo } from "../src/agent/repo.js";
import { runLoop, type LLM } from "../src/agent/loop.js";
import { TraceWriter } from "../src/trace/writer.js";
import { readTrace } from "../src/trace/reader.js";
import { FixtureReplayDriver } from "../src/driver/fixture-replay.js";
import { writeNewWorkRequestFixture } from "../src/trace/fixture-new-work-request.js";

const tmp = () => mkdtempSync(join(tmpdir(), "agent-qa-agent-"));

const OBS = {
  locus: { url: "https://app.example.com/x" },
  a11y: 'button "Save changes" [ref_1]\nbutton "Delete workspace" [ref_2]\nbutton "Manage Access" [ref_3]',
};

describe("guardrails", () => {
  const policy = defaultPolicy(["app.example.com"]);

  it("blocks navigation off the allowlist and allows subdomains", () => {
    expect(checkAction(policy, { kind: "navigate", url: "https://evil.example.net" }, OBS).allowed).toBe(false);
    expect(checkAction(policy, { kind: "navigate", url: "https://app.example.com/y" }, OBS).allowed).toBe(true);
  });

  it("blocks clicks on no-go labels, allows safe ones", () => {
    expect(checkAction(policy, { kind: "click", ref: "ref_2" }, OBS).allowed).toBe(false);
    expect(checkAction(policy, { kind: "click", ref: "ref_3" }, OBS).allowed).toBe(false);
    expect(checkAction(policy, { kind: "click", ref: "ref_1" }, OBS).allowed).toBe(true);
  });

  it("finds labels by ref", () => {
    expect(labelForRef(OBS, "ref_2")).toContain("Delete workspace");
  });
});

describe("repo grounding", () => {
  const repo = process.cwd(); // the runtime package itself is a fine test repo (inside a git tree)

  it("produces an overview", () => {
    const o = repoOverview(repo);
    expect(o).toContain("tracked files");
  });

  it("searches with rg and reads bounded slices", () => {
    expect(searchRepo(repo, "SurfaceDriver")).toContain("interface.ts");
    const slice = readRepoFile(repo, "src/driver/interface.ts", 1, 10);
    expect(slice).toContain("lines 1-10");
    expect(readRepoFile(repo, "../../../etc/passwd")).toContain("refused");
  });
});

describe("agent loop with mocked LLM", () => {
  function msg(content: Anthropic.ContentBlock[]): Anthropic.Message {
    return {
      id: "m", type: "message", role: "assistant", model: "mock", content,
      stop_reason: "tool_use", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage,
    } as Anthropic.Message;
  }
  const tool = (id: string, name: string, input: unknown): Anthropic.ContentBlock =>
    ({ type: "tool_use", id, name, input }) as Anthropic.ContentBlock;

  it("plans, acts through the driver, verifies, and finishes — all traced", async () => {
    const root = tmp();
    const fixture = writeNewWorkRequestFixture(root);
    const driver = new FixtureReplayDriver(fixture.tracePath);
    await driver.launch({ kind: "web", url: "https://app.example.com" });

    const script: Anthropic.Message[] = [
      msg([tool("t1", "emit_plan", { steps: [{ id: "P1", title: "find the button", sources: ["x.tsx"] }] })]),
      msg([tool("t2", "browser_act", { kind: "click", ref: "ref_3", target_label: "Create Work Request" })]),
      msg([
        tool("t3", "emit_verification", { plan_step_id: "P1", expected: "sheet opens", observed: "sheet opened", verdict: "pass" }),
        tool("t4", "finish", { status: "completed", summary: "proved it" }),
      ]),
    ];
    let call = 0;
    const llm: LLM = { create: async () => script[call++]! };

    const trace = new TraceWriter({ runsRoot: root, runId: "loop-test" });
    const result = await runLoop({
      mission: "test mission",
      driver,
      trace,
      policy: defaultPolicy(["app.example.com"]),
      model: "mock",
      llm,
    });

    expect(result.status).toBe("completed");
    expect(result.steps).toBe(1);
    const types = readTrace(trace.tracePath).map((e) => e.type);
    expect(types).toEqual(["observation", "plan_step", "action", "observation", "verification", "run_end"]);
  });

  it("winds down gracefully near the budget so runs end completed, not aborted", async () => {
    const root = tmp();
    const fixture = writeNewWorkRequestFixture(root);
    const driver = new FixtureReplayDriver(fixture.tracePath);
    await driver.launch({ kind: "web", url: "https://app.example.com" });

    const script: Anthropic.Message[] = [
      msg([tool("t1", "browser_act", { kind: "click", ref: "ref_3" })]),
      msg([tool("t2", "finish", { status: "completed", summary: "wrapped up in time" })]),
    ];
    let call = 0;
    let sawWindDown = false;
    const llm: LLM = {
      create: async (params) => {
        const last = params.messages.at(-1);
        if (Array.isArray(last?.content)) {
          sawWindDown ||= last.content.some(
            (b) => typeof b === "object" && b.type === "text" && b.text.includes("BUDGET NEARLY EXHAUSTED"),
          );
        }
        return script[call++]!;
      },
    };

    const trace = new TraceWriter({ runsRoot: root, runId: "winddown-test" });
    const result = await runLoop({
      mission: "test", driver, trace, policy: defaultPolicy(["app.example.com"]), model: "mock", llm,
      maxSteps: 3, // steps >= maxSteps - 2 after the first action
    });
    expect(sawWindDown).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("wrapped up in time");
  });

  it("reports guardrail blocks back to the model instead of acting", async () => {
    const root = tmp();
    const fixture = writeNewWorkRequestFixture(root);
    const driver = new FixtureReplayDriver(fixture.tracePath);
    await driver.launch({ kind: "web", url: "https://app.example.com" });

    const script: Anthropic.Message[] = [
      msg([tool("t1", "browser_act", { kind: "navigate", url: "https://not-allowed.example" })]),
      msg([tool("t2", "finish", { status: "aborted", summary: "blocked" })]),
    ];
    let call = 0;
    const captured: string[] = [];
    const llm: LLM = {
      create: async (params) => {
        const last = params.messages.at(-1);
        if (Array.isArray(last?.content)) {
          for (const block of last.content) {
            if (typeof block === "object" && block.type === "tool_result") captured.push(String(block.content));
          }
        }
        return script[call++]!;
      },
    };

    const trace = new TraceWriter({ runsRoot: root, runId: "guardrail-test" });
    const result = await runLoop({
      mission: "test", driver, trace, policy: defaultPolicy(["app.example.com"]), model: "mock", llm,
    });
    expect(result.status).toBe("aborted");
    expect(captured.some((c) => c.includes("BLOCKED by guardrail"))).toBe(true);
    const types = readTrace(trace.tracePath).map((e) => e.type);
    expect(types).toContain("error");
    expect(types.filter((t) => t === "action")).toHaveLength(0);
  });
});
