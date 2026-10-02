/**
 * Runtime HTTP server: mission-control UI + run API + SSE event streams.
 * node:http only — no framework dependency for an MVP-sized surface.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync, watch } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import type { RuntimeConfig } from "../config.js";
import { RunManager } from "./manager.js";
import { readTrace } from "../trace/reader.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jsonl": "application/x-ndjson",
  ".svg": "image/svg+xml",
};

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export function createRuntimeServer(cfg: RuntimeConfig, uiDir: string): { server: Server; manager: RunManager } {
  const manager = new RunManager(cfg);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      /* ---- API ---- */
      if (path === "/api/runs" && req.method === "POST") {
        const body = await readBody(req);
        try {
          const started = manager.start({
            mission: String(body.mission ?? ""),
            ...(body.target ? { target: String(body.target) } : {}),
            ...(body.repoPath ? { repoPath: String(body.repoPath) } : {}),
            ...(body.maxSteps ? { maxSteps: Number(body.maxSteps) } : {}),
            ...(typeof body.headless === "boolean" ? { headless: body.headless } : {}),
            ...(typeof body.demo === "boolean" ? { demo: body.demo } : {}),
            ...(body.publication ? { publication: String(body.publication) } : {}),
            ...(body.maxTokens ? { maxTokens: Number(body.maxTokens) } : {}),
          });
          return json(res, 201, started);
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }
      if (path === "/api/runs" && req.method === "GET") return json(res, 200, manager.list());

      if (path === "/api/handoff/targets" && req.method === "GET") {
        try {
          const { createHandoffSink } = await import("../handoff/sink.js");
          const targets = await createHandoffSink(cfg).listTargets();
          return json(res, 200, {
            targets,
            ...(targets.length ? {} : { reason: "no handoff targets configured (AGENTQA_HANDOFF_TARGETS)" }),
          });
        } catch (err) {
          return json(res, 200, { targets: [], reason: (err as Error).message.slice(0, 200) });
        }
      }

      const runMatch = path.match(/^\/api\/runs\/([\w.-]+)\/(events|abort|resume|handoff|continue|screenshots\/([\w.-]+))$/);
      if (runMatch) {
        const [, runId, sub, shot] = runMatch;
        const runDir = join(cfg.runsRoot, runId!);
        if (sub === "abort" && req.method === "POST") return json(res, 200, { aborted: manager.abort(runId!) });
        if (sub === "resume" && req.method === "POST") return json(res, 200, { resumed: manager.resume(runId!) });
        if (sub === "handoff" && req.method === "POST") {
          const body = await readBody(req);
          if (!body.publication) return json(res, 400, { error: "publication required" });
          try {
            return json(res, 200, await manager.handoffRun(runId!, String(body.publication), body.mission ? String(body.mission) : undefined));
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
        }
        if (sub === "continue" && req.method === "POST") {
          const body = await readBody(req);
          try {
            return json(res, 201, manager.continueRun(runId!, body.publication ? String(body.publication) : undefined));
          } catch (err) {
            return json(res, 400, { error: (err as Error).message });
          }
        }
        if (sub?.startsWith("screenshots/") && shot) {
          const p = resolve(runDir, "screenshots", shot);
          if (!p.startsWith(resolve(runDir) + sep) || !existsSync(p)) return json(res, 404, { error: "not found" });
          res.writeHead(200, { "content-type": "image/png" });
          return res.end(readFileSync(p));
        }
        if (sub === "events") {
          const tracePath = join(runDir, "trace.jsonl");
          if (!existsSync(tracePath)) return json(res, 404, { error: "unknown run" });
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const send = (data: string) => res.write(`data: ${data}\n\n`);
          // replay what exists, then follow live via writer listener or file watch
          let sent = 0;
          for (const e of readTrace(tracePath)) {
            send(JSON.stringify(e));
            sent++;
          }
          const active = manager.get(runId!);
          let cleanup: () => void;
          if (active) {
            const off = active.writer.onEvent((e) => {
              if (e.seq >= sent) send(JSON.stringify(e));
            });
            cleanup = off;
          } else {
            const watcher = watch(tracePath, () => {
              // A torn read mid-append must never crash the process — skip
              // this tick; the next change event re-reads a settled file.
              try {
                const all = readTrace(tracePath);
                for (const e of all.slice(sent)) {
                  send(JSON.stringify(e));
                  sent++;
                }
              } catch {
                /* partial write — retry on next fs event */
              }
            });
            cleanup = () => watcher.close();
          }
          const heartbeat = setInterval(() => res.write(": hb\n\n"), 15_000);
          req.on("close", () => {
            clearInterval(heartbeat);
            cleanup();
          });
          return;
        }
      }

      /* ---- static UI ---- */
      const rel = path === "/" ? "index.html" : path.slice(1);
      const file = resolve(uiDir, rel);
      if (file.startsWith(resolve(uiDir) + sep) && existsSync(file)) {
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        return res.end(readFileSync(file));
      }
      return json(res, 404, { error: "not found" });
    } catch (err) {
      // If headers already went out (e.g. mid-SSE), a second writeHead would
      // throw inside the catch and kill the process — end the stream instead.
      if (res.headersSent) {
        res.end();
        return;
      }
      return json(res, 500, { error: (err as Error).message });
    }
  });

  return { server, manager };
}
