/**
 * Handoff sinks: where a compiled work order goes once a run finishes.
 *
 * The runtime is deliberately not coupled to any one documentation service.
 * Two sinks ship. The file sink is the default and always available: it writes
 * the compiled work order to a local JSON file, so a run is useful with no
 * external service configured at all. The webhook sink is off unless
 * AGENTQA_HANDOFF_URL is set, and POSTs the same JSON payload to that URL.
 * Anything else (a docs API, a queue, a ticket tracker) implements HandoffSink.
 *
 * Auth for the webhook sink is an optional bearer token from
 * AGENTQA_HANDOFF_TOKEN. It never appears in logs or traces (TraceWriter
 * redacts it as a secret literal) and is never echoed in error messages.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type HandoffChannel = "file" | "webhook";

export interface WorkRequestInput {
  body: string;
  publication: string;
  labels?: string[];
}

export interface HandoffReceipt {
  channel: HandoffChannel;
  /** Sink-assigned identifier for the submitted work order, when there is one. */
  id?: string;
  /** Human-readable pointer: a file path, a URL, a ticket reference. */
  ref?: string;
}

export interface HandoffSink {
  readonly channel: HandoffChannel;
  /** Publication/target names the sink accepts; empty when the sink takes anything. */
  listTargets(): Promise<string[]>;
  submit(input: WorkRequestInput): Promise<HandoffReceipt>;
}

function workOrderId(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `wo-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Default sink: the work order lands as a JSON file on disk. No network, no keys. */
export class FileHandoffSink implements HandoffSink {
  readonly channel = "file" as const;
  constructor(private readonly opts: { dir: string; targets?: string[]; now?: () => Date }) {}

  listTargets(): Promise<string[]> {
    return Promise.resolve(this.opts.targets ?? []);
  }

  async submit(input: WorkRequestInput): Promise<HandoffReceipt> {
    const id = workOrderId(this.opts.now?.() ?? new Date());
    mkdirSync(this.opts.dir, { recursive: true });
    const path = join(this.opts.dir, `${id}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          id,
          createdAt: (this.opts.now?.() ?? new Date()).toISOString(),
          publication: input.publication,
          body: input.body,
          ...(input.labels ? { labels: input.labels } : {}),
        },
        null,
        2,
      ),
    );
    return { channel: this.channel, id, ref: path };
  }
}

/** Optional sink: POST the work order to a generic webhook (AGENTQA_HANDOFF_URL). */
export class WebhookHandoffSink implements HandoffSink {
  readonly channel = "webhook" as const;
  private readonly f: typeof fetch;
  constructor(private readonly opts: { url: string; token?: string; targets?: string[]; fetchImpl?: typeof fetch }) {
    this.f = opts.fetchImpl ?? fetch;
  }

  listTargets(): Promise<string[]> {
    return Promise.resolve(this.opts.targets ?? []);
  }

  async submit(input: WorkRequestInput): Promise<HandoffReceipt> {
    const res = await this.f(this.opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: JSON.stringify({
        body: input.body,
        publication: input.publication,
        ...(input.labels ? { labels: input.labels } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      // never echo the auth header; response bodies are safe to surface
      throw new Error(`handoff webhook POST → ${res.status}: ${text.slice(0, 300)}`);
    }
    let id: string | undefined;
    try {
      const parsed = text ? (JSON.parse(text) as { id?: unknown }) : {};
      if (typeof parsed.id === "string") id = parsed.id;
    } catch {
      /* a webhook that answers with something other than JSON is still a success */
    }
    return { channel: this.channel, ...(id ? { id, ref: `work order ${id}` } : {}) };
  }
}

/** Pick the sink the current configuration asks for: webhook when a URL is set, file otherwise. */
export function createHandoffSink(cfg: {
  handoffUrl?: string;
  handoffToken?: string;
  handoffDir: string;
  handoffTargets?: string[];
}): HandoffSink {
  if (cfg.handoffUrl) {
    return new WebhookHandoffSink({
      url: cfg.handoffUrl,
      ...(cfg.handoffToken ? { token: cfg.handoffToken } : {}),
      ...(cfg.handoffTargets ? { targets: cfg.handoffTargets } : {}),
    });
  }
  return new FileHandoffSink({
    dir: cfg.handoffDir,
    ...(cfg.handoffTargets ? { targets: cfg.handoffTargets } : {}),
  });
}
