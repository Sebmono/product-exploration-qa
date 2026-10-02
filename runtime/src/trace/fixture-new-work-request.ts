/**
 * Golden fixture: a synthetic exploration of the "New Work Request" flow in a
 * neutral example app (app.example.com), expressed as trace events. It has the
 * shape of a real recorded run — plan steps grounded in source, observations,
 * verifications, deltas, artifact, handoff — so tests, the replay driver, and
 * UI development exercise the full pipeline without a live run or a real target.
 */
import { TraceWriter } from "./writer.js";

export function writeNewWorkRequestFixture(runsRoot: string, runId = "fixture-new-work-request"): TraceWriter {
  let tick = 0;
  const base = Date.parse("2026-07-10T17:20:00-04:00");
  const w = new TraceWriter({ runsRoot, runId, now: () => new Date(base + tick++ * 5000) });

  w.emit("run_start", {
    mission: "Document how to kick off a New Work Request in the example demo app.",
    target: { kind: "web", url: "https://app.example.com" },
    repoPath: "/path/to/target-repo",
    driver: "live-manual (Claude + in-app browser)",
  });

  // -- planning phase, grounded in source --
  w.emit("plan_step", {
    id: "P1", title: "Locate the entry point for creating work",
    sources: ["demo-app:web/app/_components/CreateWorkRequestButton.tsx"],
    note: "Button lives in left nav; rendered only with write access",
  });
  w.emit("plan_step", {
    id: "P2", title: "Form shape: Publication + Description",
    sources: ["demo-app:web/app/_components/CreateWorkRequestForm.tsx"],
    note: "Publication select filtered to write access; free-text description",
  });
  w.emit("plan_step", {
    id: "P3", title: "Predict submit behavior",
    sources: ["demo-app:api/internal/logic/work_request.go:136"],
    note: "Submit creates a work request with Staged: true",
  });
  w.emit("plan_step", {
    id: "P4", title: "Expected outcome to verify",
    sources: ["demo-app:web/e2e/create-work-request.spec.ts"],
    note: 'Success toast with "View in Work History" link',
  });
  w.emit("plan_step", {
    id: "P5", title: "Status vocabulary for tracking",
    sources: ["https://example.com/docs/work-history"],
    note: "In Progress / Needs Attention / Merged / Cancelled",
  });

  // -- execution phase --
  w.emit("observation", {
    locus: { url: "https://app.example.com/work-history", title: "Work History - Example Docs" },
    a11ySummary:
      'table "Work History" rows[publication,summary,status,started]; statuses observed: Open, Needs Attention, Merged; filters: publication, summary, status; left nav with button "Create Work Request" [ref_3]',
    note: "E1: landing state",
  });
  w.emit("verification", {
    planStepId: "P5", expected: "Work History lists runs with documented statuses",
    observed: "Open / Needs Attention / Merged present", verdict: "pass",
  });
  w.emit("action", { kind: "click", targetRef: "ref_3", targetLabel: "Create Work Request (left nav)" });
  w.emit("verification", {
    planStepId: "P1", expected: "Create Work Request button in left nav (write access)",
    observed: "Present; collapses to unlabeled '+' at narrow widths", verdict: "pass",
  });
  w.emit("delta", {
    title: "Collapsed nav hides the button label",
    detail: "At narrow viewports the action is an unlabeled '+' icon; accessibility name persists.",
    source: "ui-only",
  });
  w.emit("observation", {
    locus: { url: "https://app.example.com/work-history", title: "Work History - Example Docs" },
    a11ySummary:
      'sheet "New Work Request": combobox "Publication" ("Select a publication"), textbox "Description" ("Describe the work request..."), button "Submit Request" [disabled], button "Cancel"',
    note: "E3: sheet open",
  });
  w.emit("verification", {
    planStepId: "P2", expected: "Two fields: Publication select + Description",
    observed: "Exactly two fields; Submit disabled until valid", verdict: "pass",
  });
  w.emit("delta", {
    title: "Submit gated on validity",
    detail: "Submit Request is disabled until both fields validate — implied by code, stated only by the UI.",
    source: "ui-only",
  });
  w.emit("action", { kind: "click", targetLabel: "Publication select" });
  w.emit("observation", {
    locus: { url: "https://app.example.com/work-history" },
    a11ySummary:
      'listbox with search: 9 publications incl. "Product Exploration Test", "External Docs", "Example Blog", "Platform Docs"',
    note: "E4: dropdown open",
  });
  w.emit("action", { kind: "click", targetLabel: 'option "Product Exploration Test"' });
  w.emit("action", {
    kind: "type", targetLabel: "Description",
    text: "Create new documentation: a how-to guide explaining how to kick off a New Work Request… (full text: docs/work-order-new-work-request.md)",
  });
  w.emit("observation", {
    locus: { url: "https://app.example.com/work-history" },
    a11ySummary: 'sheet filled; button "Submit Request" [enabled]',
    note: "E6: form valid",
  });
  w.emit("action", { kind: "click", targetLabel: "Submit Request" });
  w.emit("observation", {
    locus: { url: "https://app.example.com/work-history", title: "Work History - Example Docs" },
    a11ySummary:
      'toast "Work Request Created — Your work request has been submitted. View in Work History"; new top row: publication "Product Exploration Test", summary "Processing request…", status "Running", started "Jul 10, 5:35pm"',
    note: "E7: submitted",
  });
  w.emit("verification", {
    planStepId: "P3", expected: "Submission creates a staged work request",
    observed: "Work request created; Work History row appears immediately", verdict: "pass",
  });
  w.emit("verification", {
    planStepId: "P4", expected: 'Toast with "View in Work History" link',
    observed: "Toast rendered bottom-right with the link", verdict: "pass",
  });
  w.emit("delta", {
    title: 'Transient "Running" status',
    detail: 'A live "Running" state (with spinner) appears during processing; the docs describe only settled states.',
    source: "docs-mismatch",
  });

  // -- artifact + handoff --
  w.emit("artifact", {
    kind: "work_order",
    title: "Documentation work order: creating a work request",
    path: "docs/work-order-new-work-request.md",
  });
  w.emit("handoff", {
    channel: "file",
    publication: "Product Exploration Test",
    status: "staged",
    ref: "runs/fixture-new-work-request/handoffs/wo-fixture.json → guides/creating-a-work-request.md",
  });
  w.emit("run_end", { status: "completed", steps: 7, summary: "7/7 waypoints verified; 3 deltas; work order handed off" });

  return w;
}
