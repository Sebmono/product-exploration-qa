/**
 * R.1 spike runner: scripted (LLM-free) exploration of macOS Calculator via
 * the MacAXDriver, emitting the same v1 trace schema as web runs.
 *
 * Success criterion (docs/mvp-plan.md R.1): one scripted exploration of a
 * native macOS app producing a valid trace — proving the Surface Driver
 * interface holds across surfaces.
 */
import { join } from "node:path";
import { TraceWriter } from "../trace/writer.js";
import { readTrace } from "../trace/reader.js";
import { MacAXDriver } from "../driver/macos-ax.js";
import { labelForRef } from "../agent/guardrails.js";

function findRef(a11y: string, candidates: string[]): string | undefined {
  for (const line of a11y.split("\n")) {
    const m = line.match(/"([^"]*)" \[(ref_\d+)\]/);
    if (!m) continue;
    if (candidates.some((c) => m[1]!.toLowerCase() === c.toLowerCase())) return m[2];
  }
  return undefined;
}

/**
 * Read the calculator result from the snapshot. Quirks handled (macOS 26):
 * every character in Calculator's display is wrapped in invisible bidi marks
 * (U+200E etc.), and the window shows BOTH the expression ("2+3") and the
 * result ("5") as separate static texts — the result is the last value that
 * is a pure number once invisible marks are stripped.
 */
export function displayValue(a11y: string): string | undefined {
  let result: string | undefined;
  for (const line of a11y.split("\n")) {
    const m = line.match(/value="(.*?)"[),]/) ?? line.match(/value="(.*)"\)?$/);
    if (!m) continue;
    const cleaned = m[1]!.replace(/[‎‏⁦-⁩‪-‮\s]/g, "");
    if (/^-?[\d.,]+$/.test(cleaned)) result = cleaned; // keep the LAST pure number
  }
  return result;
}

export async function runCalculatorSpike(runsRoot: string): Promise<{ tracePath: string; passed: boolean }> {
  const runId = `spike-calculator-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const trace = new TraceWriter({ runsRoot, runId });
  const driver = new MacAXDriver({ screenshotDir: join(trace.runDir, "screenshots") });

  trace.emit("run_start", {
    mission: "Verify Calculator computes 2 + 3 = 5, via the accessibility tree",
    target: { kind: "desktop", app: "Calculator" },
    driver: driver.name,
  });
  trace.emit("plan_step", {
    id: "D1",
    title: "Locate the keypad in the AX tree",
    note: "digits and operators should be AXButton elements with stable names",
  });
  trace.emit("plan_step", {
    id: "D2",
    title: "Press 2, add, 3, equals through AX actions",
  });
  trace.emit("plan_step", {
    id: "D3",
    title: "Read the result from the display element's AXValue",
    note: "expected: 5",
  });

  let passed = false;
  try {
    await driver.launch({ kind: "desktop", app: "Calculator" });
    let obs = await driver.observe();
    trace.emit("observation", {
      locus: obs.locus,
      a11ySummary: obs.a11y,
      ...(obs.screenshotPath ? { screenshot: { path: obs.screenshotPath } } : {}),
      note: "initial keypad state",
    });

    const presses: Array<{ label: string; candidates: string[] }> = [
      { label: "2", candidates: ["2", "two"] },
      { label: "+", candidates: ["add", "+", "plus"] },
      { label: "3", candidates: ["3", "three"] },
      { label: "=", candidates: ["equals", "=", "equal"] },
    ];

    const keypadFound = presses.every((p) => findRef(obs.a11y, p.candidates));
    trace.emit("verification", {
      planStepId: "D1",
      expected: "keypad buttons 2/add/3/equals present as named AX elements",
      observed: keypadFound ? "all four found by accessible name" : `missing some of ${presses.map((p) => p.label).join(" ")}`,
      verdict: keypadFound ? "pass" : "fail",
    });
    if (!keypadFound) throw new Error("keypad not found in AX tree");

    for (const p of presses) {
      const ref = findRef(obs.a11y, p.candidates);
      if (!ref) throw new Error(`button "${p.label}" vanished between observations`);
      trace.emit("action", { kind: "click", targetRef: ref, targetLabel: `Calculator "${p.label}" — ${labelForRef(obs, ref).trim()}` });
      const result = await driver.act({ kind: "click", ref });
      if (!result.ok) throw new Error(`click "${p.label}" failed: ${result.note}`);
      obs = await driver.observe();
      trace.emit("observation", {
        locus: obs.locus,
        a11ySummary: obs.a11y,
        ...(obs.screenshotPath ? { screenshot: { path: obs.screenshotPath } } : {}),
        note: `after pressing "${p.label}"`,
      });
    }

    const shown = displayValue(obs.a11y);
    passed = shown === "5";
    trace.emit("verification", {
      planStepId: "D3",
      expected: "display AXValue is 5",
      observed: `display shows ${shown ?? "(unreadable)"}`,
      verdict: passed ? "pass" : "fail",
    });
    trace.emit("delta", {
      title: "Desktop surface, same trace",
      detail: "A native macOS app exploration emitted schema-v1 events indistinguishable from web runs — the Surface Driver contract held.",
      source: "ui-only",
    });
    trace.emit("run_end", {
      status: passed ? "completed" : "failed",
      steps: presses.length,
      summary: passed ? "2 + 3 = 5 verified via AX tree (D1-D3 all proven)" : "arithmetic verification failed",
    });
  } catch (err) {
    trace.emit("error", { message: (err as Error).message, recoverable: false });
    trace.emit("run_end", { status: "failed", steps: 0, summary: (err as Error).message });
  } finally {
    await driver.close();
  }

  readTrace(trace.tracePath); // throws if anything invalid — the R.1 acceptance gate
  return { tracePath: trace.tracePath, passed };
}
