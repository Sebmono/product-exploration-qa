/** Read and validate a JSONL trace file. */
import { readFileSync } from "node:fs";
import { parseTraceLine, type TraceEvent } from "./schema.js";

export function readTrace(path: string): TraceEvent[] {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const events = lines.map((line, i) => {
    try {
      return parseTraceLine(line);
    } catch (err) {
      throw new Error(`invalid trace event at line ${i + 1} of ${path}: ${(err as Error).message}`);
    }
  });
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.seq !== i) throw new Error(`trace ${path}: seq gap at index ${i} (got ${events[i]!.seq})`);
  }
  return events;
}
