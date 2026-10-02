/**
 * RunManager: owns the lifecycle of runs started from the UI/API.
 *
 * States: login-gate → running → done. Demo runs replay the golden fixture
 * through a real TraceWriter with pacing, so every consumer (SSE, UI, history)
 * exercises the same pipeline without keys or a browser.
 */
import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import type { RuntimeConfig } from "../config.js";
import { secretLiterals } from "../config.js";
import { TraceWriter } from "../trace/writer.js";
import { readTrace } from "../trace/reader.js";
import { writeNewWorkRequestFixture } from "../trace/fixture-new-work-request.js";
import { PlaywrightWebDriver } from "../driver/web-playwright.js";
import { runLoop } from "../agent/loop.js";
import { defaultPolicy } from "../agent/guardrails.js";
import type { TraceEvent } from "../trace/schema.js";

export type RunStatus = "login-gate" | "running" | "done" | "error";

export interface StartOptions {
  mission: string;
  target?: string;
  repoPath?: string;
  maxSteps?: number;
  headless?: boolean;
  demo?: boolean;
  loginGate?: boolean;
  /** When set, a completed run auto-compiles a work order and hands it off under this publication name. */
  publication?: string;
  maxTokens?: number;
  /** Internal: proven facts carried over from an interrupted run being resumed. */
  priorFindings?: string;
}

/** Distill a trace into the "already proven" context for a resumed run. */
export function buildPriorFindings(events: TraceEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "verification" && e.data.verdict === "pass") {
      lines.push(`- PROVEN: ${e.data.expected} (observed: ${e.data.observed})`);
    } else if (e.type === "delta") {
      lines.push(`- NOTED: ${e.data.title} — ${e.data.detail}`);
    }
  }
  const lastObs = [...events].reverse().find((e) => e.type === "observation");
  if (lastObs?.type === "observation" && lastObs.data.locus.url) {
    lines.push(`- The interrupted run's last location was ${lastObs.data.locus.url}`);
  }
  return lines.join("\n");
}

interface ActiveRun {
  id: string;
  status: RunStatus;
  writer: TraceWriter;
  controller: AbortController;
  resumeGate?: (() => void) | undefined;
}

export interface RunSummaryInfo {
  id: string;
  status: RunStatus | "recorded";
  mission?: string;
  startedAt?: string;
  endedAt?: string;
  outcome?: string;
}

export class RunManager {
  private active = new Map<string, ActiveRun>();

  constructor(private readonly cfg: RuntimeConfig) {}

  start(opts: StartOptions): { runId: string; status: RunStatus } {
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}${opts.demo ? "-demo" : ""}`;
    const writer = new TraceWriter({
      runsRoot: this.cfg.runsRoot,
      runId,
      secretLiterals: secretLiterals(this.cfg),
    });
    const controller = new AbortController();
    const run: ActiveRun = { id: runId, status: "running", writer, controller };
    this.active.set(runId, run);

    if (opts.demo) {
      this.runDemo(run, opts).catch((err) => this.fail(run, err));
      return { runId, status: run.status };
    }
    if (!this.cfg.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY missing — set it in runtime/.env");
    if (!opts.target) throw new Error("target url required for live runs");
    this.runLive(run, opts as StartOptions & { target: string }).catch((err) => this.fail(run, err));
    return { runId, status: run.status };
  }

  private fail(run: ActiveRun, err: unknown) {
    run.status = "error";
    try {
      run.writer.emit("error", { message: (err as Error).message ?? String(err), recoverable: false });
      run.writer.emit("run_end", { status: "failed", steps: 0, summary: "runtime error" });
    } catch {
      /* trace may already be closed */
    }
  }

  private async runDemo(run: ActiveRun, opts: StartOptions): Promise<void> {
    // Source events from the golden fixture, re-emit with pacing.
    const fixtureRoot = join(this.cfg.runsRoot, "..", "fixtures");
    const fixturePath = join(fixtureRoot, "fixture-new-work-request", "trace.jsonl");
    if (!existsSync(fixturePath)) writeNewWorkRequestFixture(fixtureRoot);
    const events = readTrace(fixturePath);
    for (const e of events) {
      if (run.controller.signal.aborted) {
        run.writer.emit("run_end", { status: "aborted", steps: 0, summary: "aborted by user" });
        break;
      }
      if (e.type === "run_start") {
        run.writer.emit("run_start", { ...e.data, mission: opts.mission || e.data.mission, driver: "fixture-replay" });
      } else {
        run.writer.emit(e.type, e.data as never);
      }
      await new Promise((r) => setTimeout(r, e.type === "plan_step" ? 700 : 1100));
    }
    run.status = "done";
  }

  private async runLive(run: ActiveRun, opts: StartOptions & { target: string }): Promise<void> {
    const targetHost = new URL(opts.target).hostname;
    const policy = defaultPolicy([...new Set([...this.cfg.allowedHosts, targetHost])]);
    const driver = new PlaywrightWebDriver({
      screenshotDir: join(run.writer.runDir, "screenshots"),
      headless: opts.headless ?? false,
    });
    run.writer.emit("run_start", {
      mission: opts.mission,
      target: { kind: "web", url: opts.target },
      ...(opts.repoPath ? { repoPath: opts.repoPath } : {}),
      driver: driver.name,
      model: this.cfg.model,
    });
    try {
      await driver.launch({ kind: "web", url: opts.target });

      if (opts.loginGate !== false) {
        run.status = "login-gate";
        await new Promise<void>((resolve) => {
          run.resumeGate = resolve;
          run.controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        run.resumeGate = undefined;
      }
      run.status = "running";

      if (!run.controller.signal.aborted) {
        const result = await runLoop({
          mission: opts.mission,
          driver,
          trace: run.writer,
          policy,
          model: this.cfg.model,
          ...(opts.repoPath ? { repoPath: opts.repoPath } : {}),
          ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
          maxTokens: opts.maxTokens ?? this.cfg.maxTokens,
          ...(opts.priorFindings ? { priorFindings: opts.priorFindings } : {}),
          apiKey: this.cfg.anthropicApiKey!,
          signal: run.controller.signal,
        });

        // Handoff stage: only after a run the agent itself considers complete.
        if (opts.publication && result.status === "completed" && !run.controller.signal.aborted) {
          try {
            const { performHandoff } = await import("../compile/handoff.js");
            const { createHandoffSink } = await import("../handoff/sink.js");
            const { readTrace } = await import("../trace/reader.js");
            await performHandoff({
              events: readTrace(run.writer.tracePath),
              publication: opts.publication,
              sink: createHandoffSink(this.cfg),
              model: this.cfg.model,
              ...(this.cfg.anthropicApiKey ? { apiKey: this.cfg.anthropicApiKey } : {}),
              trace: run.writer,
            });
          } catch (err) {
            run.writer.emit("error", {
              message: `handoff failed: ${(err as Error).message.slice(0, 200)}`,
              recoverable: true,
            });
          }
        }
      } else {
        run.writer.emit("run_end", { status: "aborted", steps: 0, summary: "aborted at login gate" });
      }
      run.status = "done";
    } finally {
      await driver.close().catch(() => {});
    }
  }

  /** Post-hoc handoff: compile any finished run's trace and submit it through the configured sink. */
  async handoffRun(runId: string, publication: string, missionOverride?: string): Promise<{ prompt: string; workOrderId?: string; ref?: string }> {
    const tracePath = join(this.cfg.runsRoot, runId, "trace.jsonl");
    const events = readTrace(tracePath);
    if (events.some((e) => e.type === "handoff" && e.data.status === "submitted")) {
      throw new Error("this run was already handed off — refusing to submit a duplicate");
    }
    const active = this.active.get(runId);
    const writer =
      active?.writer ??
      new TraceWriter({
        runsRoot: this.cfg.runsRoot,
        runId,
        secretLiterals: secretLiterals(this.cfg),
        startSeq: events.length,
      });
    const { performHandoff } = await import("../compile/handoff.js");
    const { createHandoffSink } = await import("../handoff/sink.js");
    const result = await performHandoff({
      events,
      publication,
      sink: createHandoffSink(this.cfg),
      model: this.cfg.model,
      ...(this.cfg.anthropicApiKey ? { apiKey: this.cfg.anthropicApiKey } : {}),
      ...(missionOverride ? { missionOverride } : {}),
      trace: writer,
    });
    return { prompt: result.prompt, ...(result.workOrderId ? { workOrderId: result.workOrderId } : {}), ...(result.ref ? { ref: result.ref } : {}) };
  }

  /** Resume an interrupted run: new live run carrying the old run's proven facts. */
  continueRun(runId: string, publication?: string): { runId: string; status: RunStatus } {
    const events = readTrace(join(this.cfg.runsRoot, runId, "trace.jsonl"));
    const start = events.find((e) => e.type === "run_start");
    if (!start || start.type !== "run_start") throw new Error("run has no run_start event");
    if (start.data.target.kind !== "web") throw new Error("only web runs can be resumed from the UI");
    const findings = buildPriorFindings(events);
    return this.start({
      mission: start.data.mission,
      target: start.data.target.url,
      ...(start.data.repoPath ? { repoPath: start.data.repoPath } : {}),
      ...(publication ? { publication } : {}),
      ...(findings ? { priorFindings: findings } : {}),
    });
  }

  resume(runId: string): boolean {
    const run = this.active.get(runId);
    if (run?.resumeGate) {
      run.resumeGate();
      return true;
    }
    return false;
  }

  abort(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run || run.status === "done" || run.status === "error") return false;
    run.controller.abort();
    return true;
  }

  get(runId: string): ActiveRun | undefined {
    return this.active.get(runId);
  }

  /** All runs: active ones plus recorded traces on disk. */
  list(): RunSummaryInfo[] {
    const out: RunSummaryInfo[] = [];
    if (existsSync(this.cfg.runsRoot)) {
      for (const dir of readdirSync(this.cfg.runsRoot)) {
        const tracePath = join(this.cfg.runsRoot, dir, "trace.jsonl");
        if (!existsSync(tracePath)) continue;
        let info: RunSummaryInfo = { id: dir, status: "recorded" };
        try {
          const events = readTrace(tracePath);
          const start = events.find((e): e is Extract<TraceEvent, { type: "run_start" }> => e.type === "run_start");
          const end = events.find((e): e is Extract<TraceEvent, { type: "run_end" }> => e.type === "run_end");
          info = {
            id: dir,
            status: this.active.get(dir)?.status ?? "recorded",
            ...(start ? { mission: start.data.mission, startedAt: start.ts } : {}),
            ...(end ? { endedAt: end.ts, outcome: end.data.status } : {}),
          };
        } catch {
          /* unreadable trace still listed by id */
        }
        out.push(info);
      }
    }
    return out.sort((a, b) => (b.startedAt ?? b.id).localeCompare(a.startedAt ?? a.id));
  }
}
