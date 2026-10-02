import { describe, expect, it } from "vitest";
import { formatAXSnapshot, refToIndex, probeAXPermission, type AXElementInfo } from "../src/driver/macos-ax.js";
import { displayValue, runCalculatorSpike } from "../src/spike/calculator.js";
import { readTrace } from "../src/trace/reader.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ELEMENTS: AXElementInfo[] = [
  { i: 0, role: "AXGroup", name: "" }, // structural noise — dropped
  { i: 1, role: "AXButton", name: "2", enabled: true },
  { i: 2, role: "AXButton", name: "add", enabled: true },
  { i: 3, role: "AXButton", name: "equals", enabled: false },
  { i: 4, role: "AXStaticText", name: "display", value: "5" },
  { i: 5, role: "AXButton", name: "button", enabled: true }, // AXRoleDescription noise — kept, name blanked
  { i: 6, role: "AXStaticText", name: "static text" }, // generic + no value + not interactive — dropped
];

describe("macOS AX snapshot formatting (pure)", () => {
  const snap = formatAXSnapshot("Calculator", "Basic", ELEMENTS);

  it("renders the same ref-tagged grammar as the web adapter", () => {
    expect(snap).toContain('app: "Calculator"');
    expect(snap).toMatch(/button "2" \[ref_1\]/);
    expect(snap).toMatch(/button "equals" \[ref_3\] \(disabled\)/);
    expect(snap).toMatch(/statictext "display" \[ref_4\] \(value="5"\)/);
  });

  it("drops unlabeled structural noise", () => {
    expect(snap).not.toContain("ref_0");
    expect(snap).not.toContain("ref_6");
  });

  it("blanks role-restating names but keeps unnamed interactive elements visible", () => {
    expect(snap).toContain('button "" [ref_5]');
  });

  it("round-trips refs to indices", () => {
    expect(refToIndex("ref_4")).toBe(4);
    expect(() => refToIndex("nonsense")).toThrow();
  });
});

describe("calculator display parsing", () => {
  // exact lines from the real 2026-07-17 trace: bidi marks (U+200E) wrap every
  // character, and expression + result are separate static texts
  const SNAPSHOT = [
    'statictext "‎2‎+‎3" [ref_5] (value="‎2‎+‎3")',
    'statictext "‎5" [ref_7] (value="‎5")',
  ].join("\n");

  it("strips invisible bidi marks and prefers the result over the expression", () => {
    expect(displayValue(SNAPSHOT)).toBe("5");
  });

  it("ignores non-numeric values and reads the initial zero state", () => {
    expect(displayValue('statictext "‎0" [ref_5] (value="‎0")')).toBe("0");
    expect(displayValue('button "Two" [ref_19]')).toBeUndefined();
  });
});

// Live spike: needs macOS Automation/Accessibility permission — run locally with
//   AGENTQA_AX_TEST=1 npm test
describe.runIf(process.env.AGENTQA_AX_TEST === "1")("calculator spike (live, permission-gated)", () => {
  it("explores Calculator and emits a valid v1 trace with passing verifications", async () => {
    const probe = await probeAXPermission();
    if (!probe.ok) throw new Error(`permission missing: ${probe.reason}`);
    const { tracePath, passed } = await runCalculatorSpike(mkdtempSync(join(tmpdir(), "pw-spike-")));
    expect(passed).toBe(true);
    const types = readTrace(tracePath).map((e) => e.type);
    expect(types[0]).toBe("run_start");
    expect(types).toContain("verification");
    expect(types.at(-1)).toBe("run_end");
  }, 120_000);
});
