/**
 * Runtime configuration. MVP posture (docs/decisions.md 2026-07-14): secrets come
 * from runtime/.env or the process environment — never from CLI args (they leak
 * into shell history) and never written to traces (TraceWriter redacts).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeConfig {
  anthropicApiKey?: string;
  /** Optional bearer token for the webhook handoff sink. */
  handoffToken?: string;
  /** When set, compiled work orders POST here instead of landing on disk. */
  handoffUrl?: string;
  /** Where the file handoff sink writes work orders. */
  handoffDir: string;
  /** Publication/target names offered in the UI's handoff selector. */
  handoffTargets: string[];
  model: string;
  /** Per-run token budget (input+output, cache writes included). */
  maxTokens: number;
  runsRoot: string;
  /** Hosts the agent is allowed to act on (guardrail v1). */
  allowedHosts: string[];
}

export function loadConfig(root = process.cwd()): RuntimeConfig {
  const envPath = join(root, ".env");
  if (existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      /* malformed .env — fall through to process env only */
    }
  }
  const env = process.env;
  const runsRoot = env.AGENTQA_RUNS_DIR ?? join(root, "runs");
  return {
    ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
    ...(env.AGENTQA_HANDOFF_TOKEN ? { handoffToken: env.AGENTQA_HANDOFF_TOKEN } : {}),
    ...(env.AGENTQA_HANDOFF_URL ? { handoffUrl: env.AGENTQA_HANDOFF_URL } : {}),
    handoffDir: env.AGENTQA_HANDOFF_DIR ?? join(runsRoot, "handoffs"),
    handoffTargets: (env.AGENTQA_HANDOFF_TARGETS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    model: env.AGENTQA_MODEL ?? "claude-sonnet-5",
    maxTokens: Number(env.AGENTQA_MAX_TOKENS ?? 1_000_000),
    runsRoot,
    allowedHosts: (env.AGENTQA_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/** Secret literals for the trace redaction filter. */
export function secretLiterals(cfg: RuntimeConfig): string[] {
  return [cfg.anthropicApiKey, cfg.handoffToken].filter((s): s is string => Boolean(s));
}
