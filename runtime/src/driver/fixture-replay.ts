/**
 * Fixture-replay driver: replays a recorded trace as if it were a live surface.
 *
 * Purpose: develop and test every trace consumer (UI streaming, compilers,
 * agent-loop plumbing) without a browser, a desktop session, or an API key.
 * observe() yields the trace's observations in order; act() consumes the
 * trace's actions and reports whether the requested action matches what the
 * recording did (a cheap drift check for tests).
 */
import type { TargetSpec } from "../trace/schema.js";
import { readTrace } from "../trace/reader.js";
import type { ActResult, Affordances, DriverAction, DriverObservation, SurfaceDriver } from "./interface.js";

export class FixtureReplayDriver implements SurfaceDriver {
  readonly name = "fixture-replay";
  readonly affordances: Affordances = { surface: "replay", a11yTree: true, screenshots: false, vision: false };

  private observations: DriverObservation[] = [];
  private actions: Array<{ kind: string; targetLabel?: string }> = [];
  private obsIdx = 0;
  private actIdx = 0;

  constructor(private readonly tracePath: string) {}

  async launch(_target: TargetSpec): Promise<void> {
    const events = readTrace(this.tracePath);
    this.observations = events
      .filter((e) => e.type === "observation")
      .map((e) => ({
        locus: e.data.locus,
        a11y: e.data.a11ySummary ?? "",
        ...(e.data.screenshot ? { screenshotPath: e.data.screenshot.path } : {}),
      }));
    this.actions = events
      .filter((e) => e.type === "action")
      .map((e) => ({ kind: e.data.kind, ...(e.data.targetLabel ? { targetLabel: e.data.targetLabel } : {}) }));
    if (this.observations.length === 0) throw new Error(`fixture ${this.tracePath} contains no observations`);
  }

  async observe(): Promise<DriverObservation> {
    const obs = this.observations[Math.min(this.obsIdx, this.observations.length - 1)]!;
    this.obsIdx++;
    return obs;
  }

  async act(action: DriverAction): Promise<ActResult> {
    const recorded = this.actions[this.actIdx];
    this.actIdx++;
    if (!recorded) return { ok: true, note: "past end of recording" };
    if (recorded.kind !== action.kind) {
      return { ok: true, note: `drift: recording did "${recorded.kind}", request was "${action.kind}"` };
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    this.obsIdx = 0;
    this.actIdx = 0;
  }
}
