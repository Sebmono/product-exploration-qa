/** Playwright adapter smoke test against a local page — no network, headless. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { PlaywrightWebDriver } from "../src/driver/web-playwright.js";

const PAGE = `<!doctype html><title>Smoke App</title>
<h1>Smoke App</h1>
<button id="open" onclick="document.getElementById('sheet').hidden=false">Create Thing</button>
<div id="sheet" hidden>
  <input aria-label="Name" id="name">
  <button id="submit" disabled>Submit Request</button>
</div>
<script>
  document.getElementById('name').addEventListener('input', (e) => {
    document.getElementById('submit').disabled = e.target.value.length === 0;
  });
</script>`;

describe("PlaywrightWebDriver", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-qa-web-"));
  const pagePath = join(dir, "app.html");
  writeFileSync(pagePath, PAGE);
  const driver = new PlaywrightWebDriver({ screenshotDir: dir, headless: true });

  beforeAll(async () => {
    await driver.launch({ kind: "web", url: "file://" + pagePath });
  }, 30_000);
  afterAll(async () => {
    await driver.close();
  });

  it("observes a labeled, ref-tagged snapshot with state, and screenshots", async () => {
    const obs = await driver.observe();
    expect(obs.locus.title).toBe("Smoke App");
    expect(obs.a11y).toContain('heading: "Smoke App"');
    expect(obs.a11y).toMatch(/button "Create Thing" \[ref_\d+\]/);
    expect(obs.screenshotPath && existsSync(obs.screenshotPath)).toBe(true);
  });

  it("acts by ref and sees the consequence in the next observation", async () => {
    let obs = await driver.observe();
    const ref = obs.a11y.match(/button "Create Thing" \[(ref_\d+)\]/)?.[1];
    expect(ref).toBeTruthy();
    expect((await driver.act({ kind: "click", ref: ref! })).ok).toBe(true);

    obs = await driver.observe();
    expect(obs.a11y).toMatch(/textbox|input/);
    expect(obs.a11y).toMatch(/button "Submit Request" \[ref_\d+\] \(disabled\)/);

    const nameRef = obs.a11y.match(/"Name" \[(ref_\d+)\]/)?.[1];
    expect((await driver.act({ kind: "type", ref: nameRef!, text: "hello" })).ok).toBe(true);

    obs = await driver.observe();
    expect(obs.a11y).toMatch(/button "Submit Request" \[ref_\d+\]( \((?!disabled)[^)]*\))?$/m);
  });

  it("reports failed actions instead of throwing", async () => {
    const result = await driver.act({ kind: "click", ref: "ref_9999" });
    expect(result.ok).toBe(false);
    expect(result.note).toBeTruthy();
  }, 15_000);
});
