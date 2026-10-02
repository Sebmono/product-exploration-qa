/**
 * Web adapter v1: Playwright behind the Surface Driver interface.
 *
 * The ONLY module allowed to import playwright (see docs/mvp-plan.md §1 —
 * "Playwright lock-in check"). Ref mechanism is our own: interactive elements
 * get short-lived data-pw-ref tags at observe() time; refs are valid until the
 * next observe(). Headed by default so a human can log in before handing off.
 */
import { chromium, type Browser, type Page } from "playwright";
import { join } from "node:path";
import type { TargetSpec } from "../trace/schema.js";
import type { ActResult, Affordances, DriverAction, DriverObservation, SurfaceDriver } from "./interface.js";

const INTERACTIVE_SELECTOR = [
  "a[href]", "button", "input", "select", "textarea", "summary",
  "[role=button]", "[role=link]", "[role=combobox]", "[role=option]",
  "[role=menuitem]", "[role=tab]", "[role=checkbox]", "[role=radio]",
  "[role=switch]", "[role=searchbox]", "[role=textbox]", "[contenteditable=true]",
].join(", ");

/** Runs in the page: tag visible interactive elements, return a text snapshot. */
function snapshotScript(selector: string): { lines: string[] } {
  const out: string[] = [];
  const title = document.title;
  if (title) out.push(`page: "${title}"`);
  document.querySelectorAll("h1, h2").forEach((h) => {
    const t = (h.textContent ?? "").trim().slice(0, 80);
    if (t) out.push(`heading: "${t}"`);
  });
  let n = 0;
  document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || style.visibility === "hidden" || style.display === "none") return;
    const ref = `ref_${++n}`;
    el.setAttribute("data-pw-ref", ref);
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const labelled = el.getAttribute("aria-labelledby");
    const name = (
      el.getAttribute("aria-label") ??
      (labelled ? (document.getElementById(labelled)?.textContent ?? "") : "") ??
      ""
    ).trim() ||
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA"
        ? ((el as HTMLInputElement).placeholder ?? "")
        : "").trim() ||
      (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    const state: string[] = [];
    if ((el as HTMLButtonElement).disabled) state.push("disabled");
    if (el.getAttribute("aria-expanded")) state.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if ((el as HTMLInputElement).value && el.tagName === "INPUT") state.push("filled");
    out.push(`${role} "${name}" [${ref}]${state.length ? " (" + state.join(", ") + ")" : ""}`);
  });
  return { lines: out };
}

export class PlaywrightWebDriver implements SurfaceDriver {
  readonly name = "web-playwright";
  readonly affordances: Affordances = { surface: "web", a11yTree: true, screenshots: true, vision: false };

  private browser?: Browser;
  private page?: Page;
  private shotCount = 0;

  constructor(
    private readonly opts: {
      screenshotDir: string;
      headless?: boolean;
      /** Max characters of a11y snapshot returned per observation. */
      snapshotBudget?: number;
    },
  ) {}

  private p(): Page {
    if (!this.page) throw new Error("driver not launched");
    return this.page;
  }

  async launch(target: TargetSpec): Promise<void> {
    if (target.kind !== "web") throw new Error(`${this.name} only handles web targets`);
    this.browser = await chromium.launch({ headless: this.opts.headless ?? false });
    this.page = await this.browser.newPage({ viewport: { width: 1280, height: 800 } });
    await this.page.goto(target.url, { waitUntil: "domcontentloaded" });
  }

  async observe(o?: { screenshot?: boolean }): Promise<DriverObservation> {
    const page = this.p();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(250); // settle animations/toasts
    const { lines } = await page.evaluate(snapshotScript, INTERACTIVE_SELECTOR);
    let a11y = lines.join("\n");
    const budget = this.opts.snapshotBudget ?? 8000;
    if (a11y.length > budget) a11y = a11y.slice(0, budget) + `\n…[truncated, ${lines.length} elements total]`;

    let screenshotPath: string | undefined;
    if (o?.screenshot !== false) {
      screenshotPath = join(this.opts.screenshotDir, `step-${String(this.shotCount++).padStart(3, "0")}.png`);
      await page.screenshot({ path: screenshotPath }).catch(() => (screenshotPath = undefined));
    }
    return {
      locus: { url: page.url(), title: await page.title() },
      a11y,
      ...(screenshotPath ? { screenshotPath } : {}),
    };
  }

  async act(action: DriverAction): Promise<ActResult> {
    const page = this.p();
    const byRef = (ref: string) => page.locator(`[data-pw-ref="${ref}"]`).first();
    try {
      switch (action.kind) {
        case "click":
          await byRef(action.ref).click({ timeout: 8000 });
          return { ok: true };
        case "type": {
          const target = action.ref ? byRef(action.ref) : page.locator(":focus");
          await target.fill(action.text, { timeout: 8000 });
          return { ok: true };
        }
        case "key":
          await page.keyboard.press(action.keys);
          return { ok: true };
        case "scroll": {
          const dy = (action.amount ?? 600) * (action.direction === "up" ? -1 : action.direction === "down" ? 1 : 0);
          const dx = (action.amount ?? 600) * (action.direction === "left" ? -1 : action.direction === "right" ? 1 : 0);
          await page.mouse.wheel(dx, dy);
          return { ok: true };
        }
        case "navigate":
          await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 15000 });
          return { ok: true };
        case "wait":
          await page.waitForTimeout(Math.min(action.ms, 10_000));
          return { ok: true };
      }
    } catch (err) {
      return { ok: false, note: (err as Error).message.split("\n")[0] ?? "action failed" };
    }
  }

  currentHost(): string | undefined {
    try {
      return this.page ? new URL(this.page.url()).hostname : undefined;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }
}
