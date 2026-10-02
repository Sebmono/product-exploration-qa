/**
 * Desktop adapter spike (R.1): macOS accessibility tree behind the Surface
 * Driver interface.
 *
 * Spike implementation rides System Events via JXA (osascript) — zero build
 * step, ships on every Mac. Production would bind AXUIElement natively (Swift
 * helper or N-API addon); see research/desktop-spike-findings.md for why.
 *
 * Permissions: the *host terminal* needs macOS Automation + Accessibility
 * permission (System Settings → Privacy & Security). Denial surfaces as
 * osascript error -1743; probePermission() detects it cleanly. This is the
 * documented #1 desktop-automation failure mode, confirmed empirically.
 *
 * Ref contract matches the web adapter: refs index the element list of the
 * LATEST observation only.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { TargetSpec } from "../trace/schema.js";
import type { ActResult, Affordances, DriverAction, DriverObservation, SurfaceDriver } from "./interface.js";

const execFileAsync = promisify(execFile);

/* ---------- pure, unit-testable core ---------- */

export interface AXElementInfo {
  i: number;
  role: string;
  name: string;
  value?: string | number | boolean | null;
  enabled?: boolean;
}

const INTERACTIVE_ROLES = new Set([
  "button", "textfield", "textarea", "checkbox", "radiobutton", "popupbutton",
  "menubutton", "combobox", "slider", "link", "menuitem", "tab", "incrementor", "switch",
]);

/** Render the raw AX element dump into the driver's snapshot text format. */
export function formatAXSnapshot(appName: string, windowName: string, elements: AXElementInfo[]): string {
  const lines = [`app: "${appName}"`, `window: "${windowName}"`];
  for (const el of elements) {
    const role = el.role.replace(/^AX/, "").toLowerCase();
    // A name that just restates the role ("button") is AXRoleDescription noise, not a label.
    const name = el.name && el.name.toLowerCase().replace(/\s+/g, "") === role ? "" : el.name;
    const interactive = INTERACTIVE_ROLES.has(role);
    if (!name && el.value == null && !interactive) continue; // unlabeled structural nodes add tokens, not signal
    const state: string[] = [];
    if (el.enabled === false) state.push("disabled");
    if (el.value != null && el.value !== "") state.push(`value=${JSON.stringify(el.value).slice(0, 60)}`);
    lines.push(`${role} "${name}" [ref_${el.i}]${state.length ? " (" + state.join(", ") + ")" : ""}`);
  }
  return lines.join("\n");
}

/** Map a ref back to the element index it encodes. */
export function refToIndex(ref: string): number {
  const m = ref.match(/^ref_(\d+)$/);
  if (!m) throw new Error(`bad ref: ${ref}`);
  return Number(m[1]);
}

/* ---------- JXA plumbing ---------- */

const JXA_SNAPSHOT = (app: string) => `
const se = Application("System Events");
const proc = se.applicationProcesses.byName(${JSON.stringify(app)});
proc.frontmost = true;
delay(0.2);
const win = proc.windows[0];
const els = win.entireContents();
const out = [];
for (let i = 0; i < els.length && i < 400; i++) {
  const e = els[i];
  const g = (fn) => { try { const v = fn(); return v == null || v === "" ? undefined : v; } catch (_) { return undefined; } };
  const attr = (n) => g(() => e.attributes.byName(n).value());
  // NOTE: System Events' description() is AXRoleDescription ("button") — the
  // real label on SwiftUI apps lives in the raw AXDescription attribute.
  out.push({
    i,
    role: g(() => e.role()) || "unknown",
    name: g(() => e.name()) || g(() => e.title()) || attr("AXDescription") || attr("AXIdentifier") || g(() => e.help()) || "",
    value: g(() => e.value()),
    enabled: g(() => e.enabled()),
  });
}
JSON.stringify({ window: (() => { try { return win.name(); } catch (_) { return ""; } })(), elements: out });
`;

const JXA_CLICK = (app: string, index: number) => `
const se = Application("System Events");
const proc = se.applicationProcesses.byName(${JSON.stringify(app)});
proc.frontmost = true;
const els = proc.windows[0].entireContents();
const e = els[${index}];
try { e.actions.byName("AXPress").perform(); } catch (_) { e.click(); }
JSON.stringify({ ok: true });
`;

const JXA_TYPE = (app: string, text: string, index?: number) => `
const se = Application("System Events");
const proc = se.applicationProcesses.byName(${JSON.stringify(app)});
proc.frontmost = true;
${index != null ? `try { proc.windows[0].entireContents()[${index}].focused = true; } catch (_) {}` : ""}
delay(0.1);
se.keystroke(${JSON.stringify(text)});
JSON.stringify({ ok: true });
`;

const JXA_KEY = (app: string, key: string) => `
const se = Application("System Events");
se.applicationProcesses.byName(${JSON.stringify(app)}).frontmost = true;
delay(0.1);
const KEYS = { enter: 36, return: 36, tab: 48, escape: 53, space: 49, delete: 51, up: 126, down: 125, left: 123, right: 124 };
const code = KEYS[${JSON.stringify(key)}.toLowerCase()];
if (code != null) se.keyCode(code); else se.keystroke(${JSON.stringify(key)});
JSON.stringify({ ok: true });
`;

async function runJXA<T>(script: string): Promise<T> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim()) as T;
  } catch (err) {
    // Strip the echoed script; keep only osascript's own error line, plus TCC guidance.
    const raw = (err as Error).message;
    const line = raw.split("\n").find((l) => l.includes("execution error")) ?? raw.split("\n")[0] ?? raw;
    throw new Error(friendlyTCCError(raw) ?? line);
  }
}

/**
 * Diagnostic: dump every AX attribute of the first N elements of an app's
 * front window. For when an app stashes its labels somewhere unexpected —
 * paste the output into an issue/conversation instead of guessing.
 */
export async function inspectAXAttributes(app: string, limit = 30): Promise<unknown> {
  return runJXA(`
const se = Application("System Events");
const proc = se.applicationProcesses.byName(${JSON.stringify(app)});
proc.frontmost = true;
delay(0.2);
const els = proc.windows[0].entireContents();
const out = [];
for (let i = 0; i < els.length && i < ${Math.min(limit, 100)}; i++) {
  const e = els[i];
  const attrs = {};
  try {
    const list = e.attributes();
    for (let a = 0; a < list.length; a++) {
      try {
        const n = list[a].name();
        let v = list[a].value();
        if (v != null && typeof v === "object") v = "[object]";
        if (typeof v === "string" && v.length > 80) v = v.slice(0, 80) + "…";
        if (v != null && v !== "") attrs[n] = v;
      } catch (_) {}
    }
  } catch (_) {}
  out.push({ i, attrs });
}
JSON.stringify(out);
`);
}

/** Map macOS TCC error codes to actionable guidance. */
export function friendlyTCCError(msg: string): string | undefined {
  if (msg.includes("-1743"))
    return "Automation permission denied (TCC -1743) — grant your terminal access to System Events in System Settings → Privacy & Security → Automation";
  if (msg.includes("-1719") || msg.includes("-25211") || /assistive access/i.test(msg))
    return "Accessibility permission denied (TCC -1719: 'not allowed assistive access') — add your terminal under System Settings → Privacy & Security → Accessibility, then QUIT AND REOPEN the terminal. macOS does not prompt for this one; it just fails.";
  return undefined;
}

/**
 * Two-layer permission probe. Layer 1 (Automation, -1743): can we talk to
 * System Events at all? Layer 2 (Accessibility, -1719): can we read UI
 * elements? Layer 2 is probed against the Dock — always running, always has
 * a UI element tree — because plain process listing passes without it.
 */
export async function probeAXPermission(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await runJXA(`JSON.stringify({ n: Application("System Events").applicationProcesses.name().length })`);
    await runJXA(
      `JSON.stringify({ n: Application("System Events").applicationProcesses.byName("Dock").lists[0].entireContents().length })`,
    );
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, reason: friendlyTCCError(msg) ?? msg.split("\n")[0] ?? "unknown" };
  }
}

/* ---------- the driver ---------- */

export class MacAXDriver implements SurfaceDriver {
  readonly name = "macos-ax";
  readonly affordances: Affordances = { surface: "desktop", a11yTree: true, screenshots: true, vision: false };

  private app = "";
  private shotCount = 0;

  constructor(private readonly opts: { screenshotDir: string; snapshotBudget?: number }) {}

  async launch(target: TargetSpec): Promise<void> {
    if (target.kind !== "desktop") throw new Error(`${this.name} only handles desktop targets`);
    const probe = await probeAXPermission();
    if (!probe.ok) throw new Error(`macOS accessibility unavailable: ${probe.reason}`);
    this.app = target.app;
    await execFileAsync("open", ["-a", this.app]);
    await new Promise((r) => setTimeout(r, 1500)); // app launch settle
  }

  async observe(o?: { screenshot?: boolean }): Promise<DriverObservation> {
    const snap = await runJXA<{ window: string; elements: AXElementInfo[] }>(JXA_SNAPSHOT(this.app));
    let a11y = formatAXSnapshot(this.app, snap.window, snap.elements);
    const budget = this.opts.snapshotBudget ?? 8000;
    if (a11y.length > budget) a11y = a11y.slice(0, budget) + "\n…[truncated]";

    let screenshotPath: string | undefined;
    if (o?.screenshot !== false) {
      screenshotPath = join(this.opts.screenshotDir, `step-${String(this.shotCount++).padStart(3, "0")}.png`);
      try {
        // -x silent; full screen — window-scoped capture needs CGWindowID, a native-binding feature
        await execFileAsync("screencapture", ["-x", screenshotPath], { timeout: 5000 });
      } catch {
        screenshotPath = undefined; // Screen Recording TCC denied — non-fatal
      }
    }
    return {
      locus: { window: `${this.app} — ${snap.window}` },
      a11y,
      ...(screenshotPath ? { screenshotPath } : {}),
    };
  }

  async act(action: DriverAction): Promise<ActResult> {
    try {
      switch (action.kind) {
        case "click":
          await runJXA(JXA_CLICK(this.app, refToIndex(action.ref)));
          return { ok: true };
        case "type":
          await runJXA(JXA_TYPE(this.app, action.text, action.ref ? refToIndex(action.ref) : undefined));
          return { ok: true };
        case "key":
          await runJXA(JXA_KEY(this.app, action.keys));
          return { ok: true };
        case "wait":
          await new Promise((r) => setTimeout(r, Math.min(action.ms, 10_000)));
          return { ok: true };
        case "scroll":
        case "navigate":
          return { ok: false, note: `${action.kind} not supported by the desktop spike adapter` };
      }
    } catch (err) {
      return { ok: false, note: (err as Error).message.split("\n")[0] ?? "action failed" };
    }
  }

  async close(): Promise<void> {
    /* leave the app running — closing other people's apps is not our call */
  }
}
