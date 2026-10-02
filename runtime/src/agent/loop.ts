/**
 * The agent loop (docs/mvp-plan.md 1.2): mission in → plan (code-grounded) →
 * act/observe/verify cycle → trace out. Claude drives via tools; every
 * consequential thing that happens is a trace event.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { SurfaceDriver, DriverAction, DriverObservation } from "../driver/interface.js";
import type { TraceWriter } from "../trace/writer.js";
import { checkAction, type GuardrailPolicy } from "./guardrails.js";
import { repoOverview, readRepoFile, searchRepo } from "./repo.js";

/** Injectable narrow slice of the Anthropic client, for tests. */
export interface LLM {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

export interface LoopOptions {
  mission: string;
  driver: SurfaceDriver;
  trace: TraceWriter;
  policy: GuardrailPolicy;
  model: string;
  repoPath?: string;
  maxSteps?: number;
  maxTokens?: number; // total budget across the run
  llm?: LLM;
  apiKey?: string;
  signal?: AbortSignal;
  /** Findings from an earlier interrupted run — injected as already-proven context. */
  priorFindings?: string;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "browser_act",
    description:
      "Perform one action on the current surface. After the action you receive a fresh observation (accessibility snapshot + current URL). Refs come from the latest observation and expire when a new one arrives.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["click", "type", "key", "scroll", "navigate", "wait"] },
        ref: { type: "string", description: "target ref from the latest observation, e.g. ref_12" },
        text: { type: "string" },
        keys: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number" },
        url: { type: "string" },
        ms: { type: "number" },
        target_label: { type: "string", description: "human-readable label of what you're acting on" },
      },
      required: ["kind"],
    },
  },
  {
    name: "search_repo",
    description: "Search the target product's source code (ripgrep). Use to ground your plan and predictions in code.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "read_repo_file",
    description: "Read a slice of a source file (max ~300 lines per call).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "path relative to the repo root" },
        start_line: { type: "number" },
        end_line: { type: "number" },
      },
      required: ["path"],
    },
  },
  {
    name: "emit_plan",
    description: "Record your exploration plan (call once, before acting on the UI; cite code/doc sources per step).",
    input_schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              note: { type: "string" },
              sources: { type: "array", items: { type: "string" } },
            },
            required: ["id", "title"],
          },
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "emit_verification",
    description: "Record that an observed behavior matched (or didn't) what the code/docs predicted.",
    input_schema: {
      type: "object",
      properties: {
        plan_step_id: { type: "string" },
        expected: { type: "string" },
        observed: { type: "string" },
        verdict: { type: "string", enum: ["pass", "fail", "unknown"] },
      },
      required: ["expected", "observed", "verdict"],
    },
  },
  {
    name: "emit_delta",
    description:
      "Record a fact discoverable only by using the product, or a mismatch between UI and code/docs. These are gold — emit them whenever you find one.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        detail: { type: "string" },
        source: { type: "string", enum: ["ui-only", "code-mismatch", "docs-mismatch"] },
      },
      required: ["title", "detail", "source"],
    },
  },
  {
    name: "finish",
    description: "End the mission with a status and a summary of what was proven.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "aborted", "failed"] },
        summary: { type: "string" },
      },
      required: ["status", "summary"],
    },
  },
];

const SYSTEM = `You are Agent QA PoC, an agent that explores software products the way a careful human user would, to produce verifiable documentation evidence.

Method — proof by walking:
1. Ground first: read the source (search_repo/read_repo_file) to predict what the UI should contain and do. Then emit_plan with steps citing those sources.
2. Walk: use browser_act to follow the plan. Observe carefully after each action.
3. Prove: after each meaningful step, emit_verification comparing code-predicted behavior to what you observed. When you find something only usage reveals (or a mismatch), emit_delta.
4. Finish with a concise summary of what was proven.

Rules:
- Stay on mission; do not wander into unrelated features.
- Operating assumption: you are exploring a SANDBOX account where creating and submitting things is expected — perform the consequential actions (submitting forms, creating records) the mission needs to be seen working for real. When a choice is underspecified (e.g. which option to pick, what to name something), pick something sensible, prefix names with "Agent QA PoC" where you name things, and record the choice as a delta so a human can review it. Destructive/no-go actions (delete, billing, access management) remain off-limits regardless.
- Never act on elements matching destructive/no-go patterns; if the guardrail blocks you, plan around it.
- Prefer the accessibility snapshot over guessing; if a needed element isn't in the snapshot, scroll or navigate — don't invent refs.
- Be economical: every action costs time and tokens. A focused 10-step walk beats a meandering 40-step one.`;

export interface LoopResult {
  status: "completed" | "aborted" | "failed";
  steps: number;
  inputTokens: number;
  outputTokens: number;
  summary?: string;
}

export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const llm: LLM =
    o.llm ??
    (() => {
      const client = new Anthropic({ apiKey: o.apiKey });
      return { create: (p) => client.messages.create(p) };
    })();

  const maxSteps = o.maxSteps ?? 40;
  const maxTokens = o.maxTokens ?? 500_000;
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastObservation: DriverObservation | undefined;
  let consecutiveFailures = 0;
  const STUCK_THRESHOLD = 4;

  const observeAndRecord = async (): Promise<string> => {
    const obs = await o.driver.observe();
    lastObservation = obs;
    o.trace.emit("observation", {
      locus: obs.locus,
      a11ySummary: obs.a11y,
      ...(obs.screenshotPath ? { screenshot: { path: obs.screenshotPath } } : {}),
    });
    return `url: ${obs.locus.url ?? "?"}\ntitle: ${obs.locus.title ?? "?"}\n\n${obs.a11y}`;
  };

  const repoNote = o.repoPath
    ? `\n\nSource repo available. Overview:\n${repoOverview(o.repoPath)}`
    : "\n\n(No source repo configured — explore UI-first and say so in your outputs.)";

  const priorNote = o.priorFindings
    ? `\n\nAn earlier run of this mission was interrupted. The following was already PROVEN — do not re-verify it; pick up where it left off and complete the remainder of the mission:\n${o.priorFindings}`
    : "";

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Mission: ${o.mission}${repoNote}${priorNote}\n\nInitial observation:\n${await observeAndRecord()}`,
    },
  ];

  let finish: { status: LoopResult["status"]; summary: string } | undefined;
  let nudged = false;
  let windDownSent = false;

  /**
   * Keep context bounded: elide bulky observation payloads from all but the
   * most recent tool_result messages. Elided text is deterministic, so the
   * cached prefix stays stable after the turn that trims it.
   */
  const compactHistory = () => {
    if (JSON.stringify(messages).length < 120_000) return;
    const resultMsgs = messages.filter((m) => m.role === "user" && Array.isArray(m.content));
    for (const m of resultMsgs.slice(0, -3)) {
      for (const block of m.content as Anthropic.ToolResultBlockParam[]) {
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > 1500) {
          block.content = block.content.slice(0, 400) + "\n…[earlier observation elided to save budget]";
        }
      }
    }
  };

  // Prompt caching: static prefix (system + tools) plus a moving breakpoint on
  // the newest message, so each turn re-reads the history from cache instead of
  // re-buying it as fresh input.
  const CACHE = { cache_control: { type: "ephemeral" as const } };
  const cachedTools = TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, ...CACHE } : t));
  const withCacheBreakpoint = (): Anthropic.MessageParam[] =>
    messages.map((m, i) => {
      if (i !== messages.length - 1) return m;
      const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
      return {
        ...m,
        content: content.map((b, j) => (j === content.length - 1 ? ({ ...b, ...CACHE } as typeof b) : b)),
      };
    });

  while (!finish && steps < maxSteps && inputTokens + outputTokens < maxTokens && !o.signal?.aborted) {
    compactHistory();
    const msg = await llm.create({
      model: o.model,
      max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM, ...CACHE }],
      tools: cachedTools,
      messages: withCacheBreakpoint(),
    });
    inputTokens += msg.usage.input_tokens + (msg.usage.cache_creation_input_tokens ?? 0);
    outputTokens += msg.usage.output_tokens;

    const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      if (nudged) {
        finish = { status: "failed", summary: "model stopped calling tools" };
        break;
      }
      nudged = true;
      messages.push({ role: "assistant", content: msg.content });
      messages.push({ role: "user", content: "Continue the mission with tool calls, or call finish." });
      continue;
    }

    messages.push({ role: "assistant", content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const tu of toolUses) {
      const input = tu.input as Record<string, unknown>;
      let result = "ok";
      try {
        switch (tu.name) {
          case "browser_act": {
            steps++;
            const action = {
              kind: input.kind,
              ref: input.ref,
              text: input.text,
              keys: input.keys,
              direction: input.direction,
              amount: input.amount,
              url: input.url,
              ms: input.ms,
            } as DriverAction;
            const verdict = checkAction(o.policy, action, lastObservation);
            if (!verdict.allowed) {
              o.trace.emit("error", { message: `guardrail blocked ${input.kind}`, recoverable: true, detail: verdict.reason ?? "" });
              result = `BLOCKED by guardrail: ${verdict.reason}. Choose a different action.`;
              break;
            }
            o.trace.emit("action", {
              kind: (input.kind as "click") ?? "wait",
              ...(typeof input.ref === "string" ? { targetRef: input.ref } : {}),
              ...(typeof input.target_label === "string" ? { targetLabel: input.target_label } : {}),
              ...(typeof input.text === "string" ? { text: input.text } : {}),
              ...(typeof input.url === "string" ? { url: input.url } : {}),
            });
            const actResult = await o.driver.act(action);
            consecutiveFailures = actResult.ok ? 0 : consecutiveFailures + 1;
            if (consecutiveFailures >= STUCK_THRESHOLD) {
              o.trace.emit("error", {
                message: `stuck: ${consecutiveFailures} consecutive failed actions`,
                recoverable: false,
              });
              finish = { status: "failed", summary: `stuck after ${consecutiveFailures} consecutive failed actions — human takeover needed` };
              result = "run halted: too many consecutive failures";
              break;
            }
            const fresh = await observeAndRecord();
            result = `${actResult.ok ? "action ok" : `action FAILED: ${actResult.note}`}\n\nFresh observation:\n${fresh}`;
            break;
          }
          case "search_repo":
            result = o.repoPath ? searchRepo(o.repoPath, String(input.query ?? "")) : "no repo configured";
            break;
          case "read_repo_file":
            result = o.repoPath
              ? readRepoFile(
                  o.repoPath,
                  String(input.path ?? ""),
                  typeof input.start_line === "number" ? input.start_line : 1,
                  typeof input.end_line === "number" ? input.end_line : undefined,
                )
              : "no repo configured";
            break;
          case "emit_plan": {
            const stepsIn = (input.steps as Array<Record<string, unknown>>) ?? [];
            for (const s of stepsIn) {
              o.trace.emit("plan_step", {
                id: String(s.id ?? "?"),
                title: String(s.title ?? ""),
                ...(typeof s.note === "string" ? { note: s.note } : {}),
                ...(Array.isArray(s.sources) ? { sources: s.sources.map(String) } : {}),
              });
            }
            result = `plan recorded (${stepsIn.length} steps)`;
            break;
          }
          case "emit_verification":
            o.trace.emit("verification", {
              ...(typeof input.plan_step_id === "string" ? { planStepId: input.plan_step_id } : {}),
              expected: String(input.expected ?? ""),
              observed: String(input.observed ?? ""),
              verdict: (input.verdict as "pass") ?? "unknown",
            });
            break;
          case "emit_delta":
            o.trace.emit("delta", {
              title: String(input.title ?? ""),
              detail: String(input.detail ?? ""),
              source: (input.source as "ui-only") ?? "ui-only",
            });
            break;
          case "finish":
            finish = {
              status: (input.status as LoopResult["status"]) ?? "completed",
              summary: String(input.summary ?? ""),
            };
            result = "mission ended";
            break;
          default:
            result = `unknown tool ${tu.name}`;
        }
      } catch (err) {
        result = `tool error: ${(err as Error).message}`;
        o.trace.emit("error", { message: result, recoverable: true });
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }

    const content: Anthropic.ContentBlockParam[] = [...results];
    const nearBudget = inputTokens + outputTokens > maxTokens * 0.85 || steps >= maxSteps - 2;
    if (nearBudget && !windDownSent && !finish) {
      windDownSent = true;
      content.push({
        type: "text",
        text: "BUDGET NEARLY EXHAUSTED. Stop exploring now: emit_verification for anything you have proven but not yet recorded, then call finish with your summary. Do not take further browser actions.",
      });
    }
    messages.push({ role: "user", content });
  }

  const status = finish?.status ?? "aborted";
  const summary =
    finish?.summary ??
    (o.signal?.aborted
      ? "aborted by user"
      : steps >= maxSteps
        ? `step cap (${maxSteps}) reached`
        : `token budget (${maxTokens}) reached`);
  const usage = `${steps} actions · ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out tokens`;
  o.trace.emit("run_end", { status, steps, summary: `${summary} (${usage})` });
  return { status, steps, inputTokens, outputTokens, ...(summary ? { summary } : {}) };
}
