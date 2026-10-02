/**
 * Work-order compiler v1 (docs/mvp-plan.md 3.1): trace → documentation work
 * order prompt + evidence bundle.
 *
 * Deterministic assembly for MVP — the prompt is built from what the run
 * PROVED (verifications, deltas, plan sources), so the writer works from evidence,
 * not vibes. An LLM-polish pass is a later refinement, deliberately: a
 * deterministic compiler is auditable and replayable (the QA-diff bet).
 */
import type { TraceEvent } from "../trace/schema.js";

export interface WorkOrder {
  title: string;
  /** The prompt to submit to the documentation writer, as plain text. */
  prompt: string;
  evidence: string[];
  publication?: string;
}

type E<T extends TraceEvent["type"]> = Extract<TraceEvent, { type: T }>;

export function compileWorkOrder(
  events: TraceEvent[],
  opts?: {
    guidePath?: string;
    /** Clean user-goal phrasing for the doc, when the run's mission text contains agent instructions. */
    missionOverride?: string;
  },
): WorkOrder {
  const start = events.find((e): e is E<"run_start"> => e.type === "run_start");
  if (!start) throw new Error("trace has no run_start");
  const mission = opts?.missionOverride ?? start.data.mission;
  const verifications = events.filter((e): e is E<"verification"> => e.type === "verification");
  const passes = verifications.filter((v) => v.data.verdict === "pass");
  const fails = verifications.filter((v) => v.data.verdict === "fail");
  const deltas = events.filter((e): e is E<"delta"> => e.type === "delta");
  const plans = events.filter((e): e is E<"plan_step"> => e.type === "plan_step");
  const observations = events.filter((e): e is E<"observation"> => e.type === "observation");
  const screenshots = observations.filter((o) => o.data.screenshot).length;
  const handoff = events.find((e): e is E<"handoff"> => e.type === "handoff");
  const sources = [...new Set(plans.flatMap((p) => p.data.sources ?? []))];

  const slug = mission.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const guidePath = opts?.guidePath ?? `guides/${slug || "exploration-guide"}.md`;

  const lines: string[] = [];
  lines.push(
    `Create new documentation: a how-to guide for the following user goal: "${mission}" ` +
      `Place it in a new markdown file at ${guidePath}.`,
  );
  lines.push("");
  lines.push(
    "The steps below were verified by direct exploration of the live product — treat them as ground truth and cover each in order:",
  );
  passes.forEach((v, i) => lines.push(`${i + 1}. ${v.data.expected} (observed: ${v.data.observed})`));
  if (deltas.length) {
    lines.push("");
    lines.push("Include these details discovered during exploration (they appear in no other source — do not omit them):");
    for (const d of deltas) lines.push(`- ${d.data.title}: ${d.data.detail}`);
  }
  if (fails.length) {
    lines.push("");
    lines.push("The following expectations did NOT hold in the live product — do not document them as working behavior:");
    for (const v of fails) lines.push(`- expected: ${v.data.expected}; actually observed: ${v.data.observed}`);
  }
  lines.push("");
  lines.push(
    "Audience: an end user new to the product. Format: one short intro paragraph, numbered step-by-step instructions, then a short tracking/what-happens-next section if applicable. Keep it under ~120 lines.",
  );

  const evidence = [
    `${passes.length}/${verifications.length} behaviors verified against the live product`,
    ...(screenshots ? [`${screenshots} step screenshots captured`] : []),
    ...(deltas.length ? [`${deltas.length} facts discoverable only by usage`] : []),
    ...(sources.length ? [`code grounding: ${sources.join(", ")}`] : []),
  ];

  return {
    title: mission,
    prompt: lines.join("\n"),
    evidence,
    ...(handoff?.data.publication ? { publication: handoff.data.publication } : {}),
  };
}
