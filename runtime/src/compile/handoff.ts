/**
 * Handoff stage: compile a finished trace into a work order, polish it to
 * house style with an LLM pass, and submit it through a HandoffSink (a local
 * JSON file by default, a generic webhook when one is configured).
 *
 * The polish pass is grounded HARD: it may only rephrase/organize facts the
 * deterministic compiler extracted from the trace — never invent steps. The
 * quality bar is the hand-written exemplar below, which produced excellent
 * downstream documentation (guides/creating-a-work-request.md).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { TraceEvent } from "../trace/schema.js";
import type { TraceWriter } from "../trace/writer.js";
import type { LLM } from "../agent/loop.js";
import { compileWorkOrder, type WorkOrder } from "./work-order.js";
import type { HandoffSink } from "../handoff/sink.js";

export const EXEMPLAR_PROMPT = `Create new documentation: a how-to guide explaining how to kick off a New Work Request in the demo app's web UI. Place it in the guides/ directory as a new markdown file (guides/creating-a-work-request.md).

Cover, in order: (1) where the Create Work Request button lives — the left navigation, visible only to users with write access to at least one publication; (2) opening the New Work Request sheet; (3) the two fields — Publication, a searchable select limited to publications where you have write access, and Description, free text describing the work you want done; (4) what happens on submit — the work request is created in a staged state and a confirmation toast appears with a "View in Work History" link; (5) how to track progress in Work History, including what the statuses mean (In Progress, Needs Attention, Merged, Cancelled) and the Details, Files, and Messages tabs; (6) how someone with publication write access opens a pull request from the staged work item once the run finishes.

Audience: an end user brand new to the app. Format: one short intro paragraph, then numbered step-by-step instructions, then a short "tracking your request" section. Keep it under ~120 lines.`;

const POLISH_SYSTEM = `You turn verified product-exploration evidence into a work order prompt for a downstream AI documentation writer.

You will receive (a) a target guide file path, (b) a documentation goal, and (c) a list of FACTS: behaviors verified live against the product, plus details discoverable only by usage. Rewrite them into a single work-order prompt with exactly this structure, matching the style of the exemplar:

1. One opening sentence: "Create new documentation: a how-to guide explaining <goal>. Place it in the guides/ directory as a new markdown file (<path>)."
2. One "Cover, in order:" paragraph enumerating (1)...(N) — each item a concrete aspect of the flow, enriched with the specific verified details (locations, field behaviors, states, what happens on submit, how to track outcomes). Fold the usage-discovered details into the relevant items naturally.
3. One closing paragraph: audience, format (short intro paragraph, numbered steps, short closing section), and a length cap (~120 lines).

Hard rules:
- Use ONLY the facts provided. Do not invent UI elements, states, or behaviors.
- If a fact says something did NOT hold, either omit that aspect or phrase the item so the doc won't claim it works.
- Output ONLY the final prompt text — no preamble, no markdown fences, no commentary.

EXEMPLAR (this is the quality bar):
${EXEMPLAR_PROMPT}`;

export async function polishWorkOrder(
  order: WorkOrder,
  opts: { llm?: LLM; model: string; apiKey?: string },
): Promise<string> {
  const llm: LLM =
    opts.llm ??
    (() => {
      const client = new Anthropic({ apiKey: opts.apiKey });
      return { create: (p) => client.messages.create(p) };
    })();
  const msg = await llm.create({
    model: opts.model,
    max_tokens: 1500,
    system: POLISH_SYSTEM,
    messages: [{ role: "user", content: order.prompt }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  // A polish pass that loses the essentials is worse than the deterministic draft.
  return text.length > 200 && text.startsWith("Create new documentation") ? text : order.prompt;
}

export interface HandoffResult {
  prompt: string;
  publication: string;
  submitted: boolean;
  /** Sink-assigned id for the submitted work order, when the sink issues one. */
  workOrderId?: string;
  /** Human-readable pointer to where the work order landed. */
  ref?: string;
}

export async function performHandoff(opts: {
  events: TraceEvent[];
  publication: string;
  missionOverride?: string;
  sink: HandoffSink;
  model: string;
  apiKey?: string;
  llm?: LLM;
  dryRun?: boolean;
  /** When provided, artifact + handoff events are appended to the run's trace. */
  trace?: TraceWriter;
}): Promise<HandoffResult> {
  const order = compileWorkOrder(opts.events, opts.missionOverride ? { missionOverride: opts.missionOverride } : {});
  let prompt = order.prompt;
  if (opts.llm || opts.apiKey) {
    try {
      prompt = await polishWorkOrder(order, {
        model: opts.model,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.llm ? { llm: opts.llm } : {}),
      });
    } catch {
      /* polish is a quality upgrade, not a dependency — deterministic draft still ships */
    }
  }
  opts.trace?.emit("artifact", { kind: "work_order", title: order.title, content: prompt });

  if (opts.dryRun) return { prompt, publication: opts.publication, submitted: false };

  const receipt = await opts.sink.submit({ body: prompt, publication: opts.publication });
  opts.trace?.emit("handoff", {
    channel: receipt.channel,
    publication: opts.publication,
    status: "submitted",
    ...(receipt.ref ? { ref: receipt.ref } : {}),
  });
  return {
    prompt,
    publication: opts.publication,
    submitted: true,
    ...(receipt.id ? { workOrderId: receipt.id } : {}),
    ...(receipt.ref ? { ref: receipt.ref } : {}),
  };
}
