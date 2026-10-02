/**
 * Append-only JSONL trace writer with secret redaction.
 *
 * One writer per run. Events are sequenced and timestamped here so producers
 * (agent loop, drivers) never manage envelope fields themselves.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TRACE_VERSION, TraceEvent, type TraceEventData, type TraceEventType } from "./schema.js";

const SECRET_KEY_PATTERN = /key|token|secret|password|credential|authorization/i;
const REDACTED = "[redacted]";

/** Replace secret-shaped values (by key name or known literal) anywhere in a JSON tree. */
export function redact(value: unknown, literals: string[] = []): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const lit of literals) {
      if (lit.length >= 8) out = out.split(lit).join(REDACTED);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, literals));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) && typeof v === "string" ? REDACTED : redact(v, literals);
    }
    return out;
  }
  return value;
}

export class TraceWriter {
  readonly runId: string;
  readonly runDir: string;
  readonly tracePath: string;
  private seq = 0;
  private readonly secretLiterals: string[];
  private readonly now: () => Date;

  constructor(opts: {
    runsRoot: string;
    runId: string;
    /** Literal secret values (API keys in memory) scrubbed from every event. */
    secretLiterals?: string[];
    now?: () => Date;
    /** Resume appending to an existing trace: first emitted event gets this seq. */
    startSeq?: number;
  }) {
    this.runId = opts.runId;
    this.runDir = join(opts.runsRoot, opts.runId);
    this.tracePath = join(this.runDir, "trace.jsonl");
    this.secretLiterals = opts.secretLiterals ?? [];
    this.now = opts.now ?? (() => new Date());
    this.seq = opts.startSeq ?? 0;
    mkdirSync(join(this.runDir, "screenshots"), { recursive: true });
  }

  emit<T extends TraceEventType>(type: T, data: TraceEventData<T>): TraceEvent {
    const event = TraceEvent.parse({
      v: TRACE_VERSION,
      run: this.runId,
      seq: this.seq++,
      ts: this.now().toISOString(),
      type,
      data: redact(data, this.secretLiterals),
    });
    appendFileSync(this.tracePath, JSON.stringify(event) + "\n");
    this.listeners.forEach((fn) => fn(event));
    return event;
  }

  /** Live subscribers (SSE bridge, tests). */
  private listeners: Array<(e: TraceEvent) => void> = [];
  onEvent(fn: (e: TraceEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }
}
