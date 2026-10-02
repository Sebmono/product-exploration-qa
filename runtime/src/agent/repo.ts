/**
 * Code grounding v1 (docs/mvp-plan.md 1.3): give the planner cheap, bounded
 * access to the target's source — an overview up front, then search/read tools.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const OUTPUT_CAP = 5000;

function cap(s: string, n = OUTPUT_CAP): string {
  return s.length > n ? s.slice(0, n) + "\n…[truncated]" : s;
}

export function repoOverview(repoPath: string): string {
  if (!existsSync(repoPath)) return `repo path not found: ${repoPath}`;
  let files: string[];
  try {
    files = execFileSync("git", ["-C", repoPath, "ls-files"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean);
  } catch {
    return `not a git repo (or git unavailable): ${repoPath}`;
  }
  const byDir = new Map<string, number>();
  for (const f of files) {
    const top = f.includes("/") ? f.slice(0, f.indexOf("/")) : "(root)";
    byDir.set(top, (byDir.get(top) ?? 0) + 1);
  }
  const dirs = [...byDir.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}/ (${n} files)`);
  let readme = "";
  for (const name of ["README.md", "CLAUDE.md", "AGENTS.md"]) {
    const p = join(repoPath, name);
    if (existsSync(p)) {
      readme = `\n--- ${name} (first lines) ---\n` + readFileSync(p, "utf8").split("\n").slice(0, 25).join("\n");
      break;
    }
  }
  return cap(`repo: ${repoPath}\n${files.length} tracked files\ntop-level: ${dirs.slice(0, 20).join(", ")}${readme}`);
}

export function searchRepo(repoPath: string, query: string): string {
  // rg when available, git grep otherwise — same shape of output either way.
  try {
    const out = execFileSync(
      "rg",
      ["-n", "-S", "-m", "4", "--max-columns", "200", "-g", "!vendor", "-g", "!node_modules", query, repoPath],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    return cap(out.replaceAll(repoPath + sep, "")) || "(no matches)";
  } catch (err) {
    const e = err as { status?: number; code?: string; message: string };
    if (e.status === 1) return "(no matches)";
    if (e.code !== "ENOENT") return `search failed: ${e.message.split("\n")[0]}`;
  }
  try {
    const out = execFileSync("git", ["-C", repoPath, "grep", "-n", "-I", "--max-count=4", "-e", query], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return cap(out) || "(no matches)";
  } catch (err) {
    const e = err as { status?: number; message: string };
    return e.status === 1 ? "(no matches)" : `search failed: ${e.message.split("\n")[0]}`;
  }
}

export function readRepoFile(repoPath: string, relPath: string, startLine = 1, endLine?: number): string {
  const abs = resolve(repoPath, relPath);
  if (!abs.startsWith(resolve(repoPath) + sep)) return "path escapes the repo — refused";
  if (!existsSync(abs)) return `file not found: ${relPath}`;
  const lines = readFileSync(abs, "utf8").split("\n");
  const end = Math.min(endLine ?? startLine + 120, startLine + 300, lines.length);
  const slice = lines.slice(startLine - 1, end).map((l, i) => `${startLine + i}\t${l}`);
  return cap(`${relPath} lines ${startLine}-${end} of ${lines.length}\n` + slice.join("\n"));
}
