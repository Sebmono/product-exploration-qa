import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkOrder } from "../src/compile/work-order.js";
import { FileHandoffSink, WebhookHandoffSink } from "../src/handoff/sink.js";
import { readTrace } from "../src/trace/reader.js";
import { writeNewWorkRequestFixture } from "../src/trace/fixture-new-work-request.js";

describe("work-order compiler", () => {
  const events = readTrace(writeNewWorkRequestFixture(mkdtempSync(join(tmpdir(), "pw-compile-"))).tracePath);

  it("compiles the golden trace into an evidence-grounded work order prompt", () => {
    const order = compileWorkOrder(events);
    expect(order.title).toContain("New Work Request");
    expect(order.prompt).toContain("Create new documentation");
    expect(order.prompt).toContain("guides/");
    // verified behaviors become numbered ground-truth steps
    expect(order.prompt).toMatch(/1\. .+observed:/);
    // deltas are demanded, not optional
    expect(order.prompt).toContain("do not omit them");
    expect(order.prompt).toContain("Running");
    expect(order.publication).toBe("Product Exploration Test");
    expect(order.evidence.some((e) => e.includes("5/5 behaviors verified"))).toBe(true);
    expect(order.evidence.some((e) => e.includes("code grounding"))).toBe(true);
  });

  it("routes failed verifications into do-not-document warnings", () => {
    const withFail = [...events];
    withFail.splice(events.length - 1, 0, {
      v: 1, run: "x", seq: 99, ts: new Date().toISOString(), type: "verification",
      data: { expected: "export button exists", observed: "no export anywhere", verdict: "fail" },
    });
    // re-sequence
    const fixed = withFail.map((e, i) => ({ ...e, seq: i }));
    const order = compileWorkOrder(fixed as never);
    expect(order.prompt).toContain("did NOT hold");
    expect(order.prompt).toContain("no export anywhere");
  });
});

describe("WebhookHandoffSink", () => {
  function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): typeof fetch {
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
      const { status, body } = handler(String(url), init ?? {});
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  it("POSTs the work order with optional bearer auth", async () => {
    let captured: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const sink = new WebhookHandoffSink({
      url: "https://handoff.test/hooks/work-orders",
      token: "hook-token-123",
      fetchImpl: mockFetch((url, init) => {
        captured = {
          url,
          auth: (init.headers as Record<string, string>).authorization,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        };
        return { status: 200, body: { id: "wo-1" } };
      }),
    });
    const out = await sink.submit({ body: "please document X", publication: "Product Exploration Test" });
    expect(out).toMatchObject({ channel: "webhook", id: "wo-1" });
    expect(captured.url).toBe("https://handoff.test/hooks/work-orders");
    expect(captured.auth).toBe("Bearer hook-token-123");
    expect(captured.body).toMatchObject({ body: "please document X", publication: "Product Exploration Test" });
  });

  it("surfaces webhook errors without leaking the token", async () => {
    const sink = new WebhookHandoffSink({
      url: "https://handoff.test/hooks/work-orders",
      token: "hook-token-123",
      fetchImpl: mockFetch(() => ({ status: 401, body: { error: "unauthorized" } })),
    });
    const submit = () => sink.submit({ body: "x", publication: "X" });
    await expect(submit()).rejects.toThrow(/401/);
    await expect(submit()).rejects.not.toThrow(/hook-token-123/);
  });
});

describe("FileHandoffSink", () => {
  it("writes the work order as JSON and returns the path", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pw-sink-")), "handoffs");
    const sink = new FileHandoffSink({ dir });
    const out = await sink.submit({ body: "please document X", publication: "Product Exploration Test" });
    expect(out.channel).toBe("file");
    expect(out.ref).toContain(dir);
    const written = JSON.parse(readFileSync(out.ref!, "utf8"));
    expect(written).toMatchObject({ id: out.id, body: "please document X", publication: "Product Exploration Test" });
  });

  it("offers only the configured targets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-sink-"));
    expect(await new FileHandoffSink({ dir }).listTargets()).toEqual([]);
    expect(await new FileHandoffSink({ dir, targets: ["Docs"] }).listTargets()).toEqual(["Docs"]);
  });
});
