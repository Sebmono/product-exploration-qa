/**
 * Trace event schema v1 — the spine of Agent QA PoC.
 *
 * Every consumer (live mission-control UI, work-order compiler, run history,
 * future QA replay/diff) reads this one format. Version it; never break v1
 * readers silently.
 */
import { z } from "zod";

export const TRACE_VERSION = 1;

/* ---------- shared fragments ---------- */

export const TargetSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("web"), url: z.string().url() }),
  z.object({ kind: z.literal("desktop"), app: z.string().min(1) }),
]);
export type TargetSpec = z.infer<typeof TargetSpec>;

/** Where the agent currently "is" on the surface. */
export const Locus = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  window: z.string().optional(),
});
export type Locus = z.infer<typeof Locus>;

export const Screenshot = z.object({
  /** Path relative to the run directory. */
  path: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

/* ---------- event payloads ---------- */

export const RunStart = z.object({
  mission: z.string().min(1),
  target: TargetSpec,
  repoPath: z.string().optional(),
  driver: z.string(),
  model: z.string().optional(),
});

export const PlanStep = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string().optional(),
  /** Code/doc citations that ground this step (repo paths, doc URLs). */
  sources: z.array(z.string()).optional(),
});

export const Observation = z.object({
  locus: Locus,
  /** Serialized accessibility snapshot (token-budgeted, driver-normalized). */
  a11ySummary: z.string().optional(),
  screenshot: Screenshot.optional(),
  note: z.string().optional(),
});

export const Action = z.object({
  kind: z.enum(["click", "type", "scroll", "key", "navigate", "launch", "wait"]),
  /** Driver-scoped element ref from the preceding observation. */
  targetRef: z.string().optional(),
  /** Human-readable label of the target ("Create Work Request button"). */
  targetLabel: z.string().optional(),
  text: z.string().optional(),
  url: z.string().optional(),
  note: z.string().optional(),
});

export const Verification = z.object({
  planStepId: z.string().optional(),
  expected: z.string(),
  observed: z.string(),
  verdict: z.enum(["pass", "fail", "unknown"]),
});

/** A fact discoverable only by using the product (or a mismatch with code/docs). */
export const Delta = z.object({
  title: z.string(),
  detail: z.string(),
  source: z.enum(["ui-only", "code-mismatch", "docs-mismatch"]),
});

export const Artifact = z.object({
  kind: z.enum(["work_order", "screenshot_bundle", "guide", "note"]),
  title: z.string(),
  path: z.string().optional(),
  content: z.string().optional(),
});

export const Handoff = z.object({
  channel: z.enum(["file", "webhook", "manual"]),
  publication: z.string().optional(),
  status: z.string(),
  /** External reference: work order id, file path, PR URL, etc. */
  ref: z.string().optional(),
});

export const ErrorEvent = z.object({
  message: z.string(),
  recoverable: z.boolean(),
  detail: z.string().optional(),
});

export const RunEnd = z.object({
  status: z.enum(["completed", "aborted", "failed"]),
  steps: z.number().int().nonnegative(),
  summary: z.string().optional(),
});

/* ---------- envelope ---------- */

const base = { v: z.literal(TRACE_VERSION), run: z.string(), seq: z.number().int().nonnegative(), ts: z.string() };

export const TraceEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run_start"), data: RunStart }),
  z.object({ ...base, type: z.literal("plan_step"), data: PlanStep }),
  z.object({ ...base, type: z.literal("observation"), data: Observation }),
  z.object({ ...base, type: z.literal("action"), data: Action }),
  z.object({ ...base, type: z.literal("verification"), data: Verification }),
  z.object({ ...base, type: z.literal("delta"), data: Delta }),
  z.object({ ...base, type: z.literal("artifact"), data: Artifact }),
  z.object({ ...base, type: z.literal("handoff"), data: Handoff }),
  z.object({ ...base, type: z.literal("error"), data: ErrorEvent }),
  z.object({ ...base, type: z.literal("run_end"), data: RunEnd }),
]);
export type TraceEvent = z.infer<typeof TraceEvent>;
export type TraceEventType = TraceEvent["type"];
export type TraceEventData<T extends TraceEventType> = Extract<TraceEvent, { type: T }>["data"];

/** Parse one JSONL line into a validated event. Throws on invalid input. */
export function parseTraceLine(line: string): TraceEvent {
  return TraceEvent.parse(JSON.parse(line));
}
