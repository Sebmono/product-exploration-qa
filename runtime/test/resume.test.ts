import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPriorFindings, RunManager } from "../src/server/manager.js";
import { readTrace } from "../src/trace/reader.js";
import { TraceWriter } from "../src/trace/writer.js";
import { writeNewWorkRequestFixture } from "../src/trace/fixture-new-work-request.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pw-resume-"));

describe("buildPriorFindings", () => {
  it("distills passed verifications, deltas, and last location from a trace", () => {
    const events = readTrace(writeNewWorkRequestFixture(tmp()).tracePath);
    const findings = buildPriorFindings(events);
    expect(findings).toContain("PROVEN: Work History lists runs");
    expect(findings).toContain("NOTED: Submit gated on validity");
    expect(findings).toContain("last location was https://app.example.com");
    expect(findings).not.toContain("fail"); // only passes carry over
  });
});

describe("TraceWriter startSeq", () => {
  it("appends to an existing trace without breaking seq validation", () => {
    const root = tmp();
    const w1 = writeNewWorkRequestFixture(root);
    const before = readTrace(w1.tracePath).length;
    const w2 = new TraceWriter({ runsRoot: root, runId: "fixture-new-work-request", startSeq: before });
    w2.emit("handoff", { channel: "webhook", status: "submitted", publication: "X" });
    const events = readTrace(w1.tracePath); // throws on any seq gap
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)!.type).toBe("handoff");
  });
});

describe("RunManager post-hoc operations", () => {
  const cfg = { handoffDir: "", handoffTargets: [], model: "mock", runsRoot: "", allowedHosts: [], maxTokens: 1000 };

  it("refuses a duplicate handoff", async () => {
    const root = tmp();
    writeNewWorkRequestFixture(root); // fixture already contains a submitted-ish handoff? (status: staged)
    const manager = new RunManager({ ...cfg, runsRoot: root, handoffDir: join(root, "handoffs") });
    // add a submitted handoff to trigger the guard
    const before = readTrace(join(root, "fixture-new-work-request", "trace.jsonl")).length;
    new TraceWriter({ runsRoot: root, runId: "fixture-new-work-request", startSeq: before }).emit("handoff", {
      channel: "webhook", status: "submitted", publication: "X",
    });
    await expect(manager.handoffRun("fixture-new-work-request", "X")).rejects.toThrow(/already handed off/);
  });

  it("hands off to a local JSON file when no webhook is configured", async () => {
    const root = tmp();
    writeNewWorkRequestFixture(root);
    const dir = join(root, "handoffs");
    const manager = new RunManager({ ...cfg, runsRoot: root, handoffDir: dir });
    const out = await manager.handoffRun("fixture-new-work-request", "X");
    expect(out.ref).toContain(dir);
    expect(JSON.parse(readFileSync(out.ref!, "utf8"))).toMatchObject({ publication: "X", body: out.prompt });
  });
});
