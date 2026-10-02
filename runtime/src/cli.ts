#!/usr/bin/env node
/**
 * agent-qa CLI.
 *
 * Phase 0 commands:
 *   fixture              regenerate the golden New Work Request fixture
 *   validate <trace>     parse + schema-validate a trace file
 *   replay <trace>       stream a trace through the FixtureReplayDriver (smoke)
 */
import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadConfig, secretLiterals } from "./config.js";
import { writeNewWorkRequestFixture } from "./trace/fixture-new-work-request.js";
import { readTrace } from "./trace/reader.js";
import { FixtureReplayDriver } from "./driver/fixture-replay.js";
import { PlaywrightWebDriver } from "./driver/web-playwright.js";
import { TraceWriter } from "./trace/writer.js";
import { runLoop } from "./agent/loop.js";
import { defaultPolicy } from "./agent/guardrails.js";

const [, , cmd, ...args] = process.argv;

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Resolve --run <id|latest|trace.jsonl> to a trace path. */
function resolveTrace(runRef: string, runsRoot: string): string {
  if (runRef.endsWith(".jsonl")) return runRef;
  if (runRef === "latest") {
    const runs = readdirSync(runsRoot)
      .filter((d) => existsSync(join(runsRoot, d, "trace.jsonl")))
      .sort((a, b) => statSync(join(runsRoot, a, "trace.jsonl")).mtimeMs - statSync(join(runsRoot, b, "trace.jsonl")).mtimeMs);
    const last = runs.at(-1);
    if (!last) throw new Error(`no runs found in ${runsRoot}`);
    console.error(`(latest → ${last})`);
    return join(runsRoot, last, "trace.jsonl");
  }
  return join(runsRoot, runRef, "trace.jsonl");
}
function has(name: string): boolean {
  return args.includes(`--${name}`);
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  switch (cmd) {
    case "fixture": {
      const root = join(process.cwd(), "fixtures");
      const w = writeNewWorkRequestFixture(root);
      console.log(`fixture written: ${w.tracePath}`);
      return 0;
    }
    case "validate": {
      const path = args[0];
      if (!path) return usage();
      const events = readTrace(path);
      const byType = new Map<string, number>();
      for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
      console.log(`${path}: ${events.length} events, all valid (schema v1)`);
      for (const [t, n] of [...byType.entries()].sort()) console.log(`  ${t.padEnd(14)} ${n}`);
      return 0;
    }
    case "replay": {
      const path = args[0];
      if (!path) return usage();
      const driver = new FixtureReplayDriver(path);
      await driver.launch({ kind: "web", url: "https://replay.invalid" });
      let obs = await driver.observe();
      let i = 0;
      while (i++ < 50 && obs.a11y) {
        console.log(`[${i}] ${obs.locus.url ?? obs.locus.window ?? "?"} :: ${obs.a11y.slice(0, 100)}…`);
        const next = await driver.observe();
        if (next === obs || next.a11y === obs.a11y) break;
        obs = next;
      }
      await driver.close();
      console.log(`replay ok (driver: ${driver.name}, runsRoot: ${cfg.runsRoot})`);
      return 0;
    }
    case "run": {
      const mission = flag("mission");
      const target = flag("target");
      if (!mission || !target) return usage();
      if (!cfg.anthropicApiKey) {
        console.error("ANTHROPIC_API_KEY missing — set it in runtime/.env (see .env.example)");
        return 1;
      }
      const repoPath = flag("repo");
      const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const trace = new TraceWriter({ runsRoot: cfg.runsRoot, runId, secretLiterals: secretLiterals(cfg) });
      const targetHost = new URL(target).hostname;
      const policy = defaultPolicy([...new Set([...cfg.allowedHosts, targetHost])]);
      const driver = new PlaywrightWebDriver({
        screenshotDir: join(trace.runDir, "screenshots"),
        headless: has("headless"),
      });

      trace.emit("run_start", {
        mission,
        target: { kind: "web", url: target },
        ...(repoPath ? { repoPath } : {}),
        driver: driver.name,
        model: cfg.model,
      });
      console.log(`run: ${runId}\ntrace: ${trace.tracePath}`);

      await driver.launch({ kind: "web", url: target });

      if (!has("no-login-gate")) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        await rl.question("Log into the target in the opened browser if needed, then press Enter to hand off to the agent… ");
        rl.close();
      }

      try {
        const result = await runLoop({
          mission,
          driver,
          trace,
          policy,
          model: cfg.model,
          ...(repoPath ? { repoPath } : {}),
          ...(flag("max-steps") ? { maxSteps: Number(flag("max-steps")) } : {}),
          maxTokens: flag("max-tokens") ? Number(flag("max-tokens")) : cfg.maxTokens,
          apiKey: cfg.anthropicApiKey,
        });
        console.log(
          `\n${result.status} in ${result.steps} steps · ${result.inputTokens} in / ${result.outputTokens} out tokens\n${result.summary ?? ""}`,
        );
        const pub = flag("publication");
        if (pub && result.status === "completed") {
          const { performHandoff } = await import("./compile/handoff.js");
          const { createHandoffSink } = await import("./handoff/sink.js");
          const h = await performHandoff({
            events: readTrace(trace.tracePath),
            publication: pub,
            sink: createHandoffSink(cfg),
            model: cfg.model,
            ...(cfg.anthropicApiKey ? { apiKey: cfg.anthropicApiKey } : {}),
            trace,
          });
          console.log(`handed off to publication "${pub}"${h.ref ? ` → ${h.ref}` : ""}`);
        }
        return result.status === "completed" ? 0 : 1;
      } finally {
        await driver.close();
      }
    }
    case "compile": {
      const runRef = flag("run");
      if (!runRef) return usage();
      const tracePath = resolveTrace(runRef, cfg.runsRoot);
      const { compileWorkOrder } = await import("./compile/work-order.js");
      const order = compileWorkOrder(readTrace(tracePath), flag("mission") ? { missionOverride: flag("mission")! } : {});
      console.log(`# ${order.title}\n\n## Work order prompt\n\n${order.prompt}\n\n## Evidence\n${order.evidence.map((e) => `- ${e}`).join("\n")}`);
      return 0;
    }
    case "handoff": {
      const runRef = flag("run");
      const publication = flag("publication");
      if (!runRef || !publication) return usage();
      const tracePath = resolveTrace(runRef, cfg.runsRoot);
      const { performHandoff } = await import("./compile/handoff.js");
      const { createHandoffSink } = await import("./handoff/sink.js");
      const result = await performHandoff({
        events: readTrace(tracePath),
        publication,
        sink: createHandoffSink(cfg),
        model: cfg.model,
        ...(cfg.anthropicApiKey ? { apiKey: cfg.anthropicApiKey } : {}),
        ...(flag("mission") ? { missionOverride: flag("mission")! } : {}),
        dryRun: has("dry-run"),
      });
      if (!result.submitted) {
        console.log(`[dry-run] would submit to publication "${publication}":\n\n${result.prompt}`);
      } else {
        console.log(`work order submitted${result.ref ? `: ${result.ref}` : ""}`);
      }
      return 0;
    }
    case "ax-inspect": {
      const app = flag("app") ?? "Calculator";
      const { probeAXPermission, inspectAXAttributes } = await import("./driver/macos-ax.js");
      const probe = await probeAXPermission();
      if (!probe.ok) {
        console.error(probe.reason);
        return 1;
      }
      console.log(JSON.stringify(await inspectAXAttributes(app, Number(flag("limit") ?? 30)), null, 2));
      return 0;
    }
    case "spike": {
      const { probeAXPermission } = await import("./driver/macos-ax.js");
      const probe = await probeAXPermission();
      if (!probe.ok) {
        console.error(`cannot run desktop spike: ${probe.reason}`);
        console.error("Run this from your own terminal (Terminal.app/iTerm) so macOS can prompt for permission.");
        return 1;
      }
      const { runCalculatorSpike } = await import("./spike/calculator.js");
      const { tracePath, passed } = await runCalculatorSpike(cfg.runsRoot);
      console.log(`${passed ? "SPIKE PASSED" : "SPIKE FAILED"} — trace: ${tracePath}`);
      console.log("Watch it in mission control: npx tsx src/cli.ts serve, then pick the spike run from the history strip.");
      return passed ? 0 : 1;
    }
    case "serve": {
      const { createRuntimeServer } = await import("./server/http.js");
      const { fileURLToPath } = await import("node:url");
      const { dirname } = await import("node:path");
      const uiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
      const port = Number(flag("port") ?? 4174);
      const { server } = createRuntimeServer(cfg, uiDir);
      // A local mission-control server should log-and-survive, not die mid-run.
      process.on("uncaughtException", (err) => console.error("[agent-qa] uncaught exception:", err.message));
      process.on("unhandledRejection", (err) => console.error("[agent-qa] unhandled rejection:", (err as Error)?.message ?? err));
      server.listen(port, () => console.log(`agent-qa mission control: http://localhost:${port}`));
      await new Promise(() => {}); // run until killed
      return 0;
    }
    default:
      return usage();
  }
}

function usage(): number {
  console.error(
    "usage: agent-qa <command>\n" +
      "  fixture                            regenerate the golden fixture\n" +
      "  validate <trace.jsonl>             schema-validate a trace\n" +
      "  replay <trace.jsonl>               replay a trace (no browser)\n" +
      "  run --mission <text> --target <url> [--repo <path>] [--publication <name>] [--max-steps N] [--headless] [--no-login-gate]\n" +
      "  compile --run <runId|latest|trace.jsonl> [--mission <goal>]  build the work order from a trace\n" +
      "  handoff --run <runId|latest> --publication <name> [--dry-run] [--mission <goal>]  compile + polish + submit via the configured handoff sink\n" +
      "  serve [--port 4174]                mission control UI + API\n" +
      "  spike                              desktop R&D spike: explore macOS Calculator via the AX tree\n" +
      "  ax-inspect [--app <name>] [--limit N]  dump raw AX attributes of an app's front window (diagnostic)",
  );
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
