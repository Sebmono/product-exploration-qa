/* Agent QA PoC mission control (live) — renders trace events streamed over SSE. */

const $ = (id) => document.getElementById(id);
let es = null;
let currentRun = null;
let planSteps = new Map(); // id -> element
let counts = { verifications: 0, passes: 0, deltas: 0, actions: 0 };

/* ---------- rendering ---------- */

function reset() {
  $("trace-list").innerHTML = "";
  $("paper-body").innerHTML = "";
  $("paper-doc").hidden = true;
  $("paper-empty").hidden = false;
  $("shot").hidden = true;
  $("a11y-view").hidden = true;
  $("vp-idle").hidden = false;
  $("paper-stamp").textContent = "IN PROGRESS";
  $("paper-stamp").classList.remove("submitted");
  planSteps = new Map();
  counts = { verifications: 0, passes: 0, deltas: 0, actions: 0 };
  sawHandoff = false;
  $("order-actions").hidden = true;
  $("order-msg").textContent = "";
}
let sawHandoff = false;

function traceGroup(label) {
  const el = document.createElement("div");
  el.className = "trace-group";
  el.textContent = label;
  $("trace-list").appendChild(el);
}

function traceStep(title, note, noteClass) {
  const el = document.createElement("div");
  el.className = "trace-step active";
  el.innerHTML = `<span class="wp"></span><div class="trace-title"></div>` +
    (note ? `<div class="trace-note ${noteClass || ""}"></div>` : "");
  el.querySelector(".trace-title").textContent = title;
  if (note) el.querySelector(".trace-note").textContent = note;
  $("trace-list").appendChild(el);
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return el;
}

function verify(el) { if (el) { el.classList.remove("active"); el.classList.add("verified"); } }

function status(cls, text) {
  $("run-status").className = "chip chip-status " + cls;
  $("run-status-text").textContent = text;
}

function paperLine(html) {
  $("paper-empty").hidden = true;
  $("paper-doc").hidden = false;
  const p = document.createElement("p");
  p.innerHTML = html;
  $("paper-body").appendChild(p);
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let groups = { plan: false, walk: false };

function render(e) {
  const d = e.data;
  switch (e.type) {
    case "run_start":
      reset();
      groups = { plan: false, walk: false };
      status("running", "exploring");
      $("trace-phase").textContent = "run " + e.run;
      $("paper-meta").textContent = `mission: ${d.mission}`;
      $("vc-url").textContent = d.target?.url ?? "—";
      paperLine(`<strong>Mission.</strong> ${esc(d.mission)}`);
      if (d.repoPath) paperLine(`Grounded in <span class="cite">${esc(d.repoPath)}</span> via ${esc(d.driver)}.`);
      break;
    case "plan_step": {
      if (!groups.plan) { traceGroup("Plan — grounded in source"); groups.plan = true; }
      const el = traceStep(`${d.id} · ${d.title}`, [d.note, ...(d.sources ?? [])].filter(Boolean).join(" · "));
      planSteps.set(d.id, el);
      break;
    }
    case "observation": {
      if (!groups.walk && counts.actions === 0 && planSteps.size > 0) { traceGroup("Walk — live product"); groups.walk = true; }
      $("vp-idle").hidden = true;
      $("walk-caption").textContent = d.note ?? d.locus?.title ?? "";
      if (d.locus?.url) $("vc-url").textContent = d.locus.url;
      if (d.screenshot?.path && currentRun) {
        const file = d.screenshot.path.split("/").pop();
        $("shot").src = `/api/runs/${currentRun}/screenshots/${file}`;
        $("shot").hidden = false;
        $("a11y-view").hidden = true;
      } else if (d.a11ySummary) {
        $("a11y-view").textContent = d.a11ySummary;
        $("a11y-view").hidden = false;
        $("shot").hidden = true;
      }
      break;
    }
    case "action": {
      counts.actions++;
      if (!groups.walk) { traceGroup("Walk — live product"); groups.walk = true; }
      const label = d.targetLabel ?? d.url ?? d.targetRef ?? "";
      const el = traceStep(`${d.kind} ${label}`.trim(), d.text ? `“${d.text.slice(0, 90)}…”` : undefined);
      setTimeout(() => verify(el), 400);
      break;
    }
    case "verification": {
      counts.verifications++;
      if (d.verdict === "pass") counts.passes++;
      const el = traceStep(`verify: ${d.expected}`, `${d.verdict.toUpperCase()} — ${d.observed}`, d.verdict === "pass" ? "" : "err");
      verify(el);
      verify(planSteps.get(d.planStepId));
      paperLine(`<strong>${d.verdict === "pass" ? "Proven" : "Mismatch"}.</strong> ${esc(d.expected)} → ${esc(d.observed)}`);
      break;
    }
    case "delta": {
      counts.deltas++;
      traceStep(`Δ ${d.title}`, d.detail, "delta");
      paperLine(`<strong>Δ ${esc(d.title)}.</strong> ${esc(d.detail)} <span class="cite">${esc(d.source)}</span>`);
      break;
    }
    case "artifact":
      paperLine(`<strong>Artifact.</strong> ${esc(d.title)} ${d.path ? `<span class="cite">${esc(d.path)}</span>` : ""}`);
      break;
    case "handoff":
      sawHandoff = true;
      $("handoff-btn").hidden = true;
      paperLine(`<strong>Hand-off.</strong> ${esc(d.channel)} → ${esc(d.publication ?? "")} (${esc(d.status)}) ${d.ref ? `<span class="cite">${esc(d.ref)}</span>` : ""}`);
      break;
    case "error":
      traceStep("error", d.message + (d.detail ? " — " + d.detail : ""), "err");
      break;
    case "run_end": {
      status("done", d.status);
      $("trace-phase").textContent = `run ${d.status} · ${counts.passes}/${counts.verifications} verified · ${counts.deltas} deltas`;
      $("paper-stamp").textContent = d.status === "completed" ? "READY FOR HANDOFF" : d.status.toUpperCase();
      if (d.status === "completed") $("paper-stamp").classList.add("submitted");
      if (d.summary) paperLine(`<strong>Summary.</strong> ${esc(d.summary)}`);
      $("start-btn").disabled = false;
      $("abort-btn").hidden = true;
      $("resume-btn").hidden = true;
      $("paper-doc").hidden = false;
      $("paper-empty").hidden = true;
      $("order-actions").hidden = false;
      $("handoff-btn").hidden = sawHandoff;
      $("continue-btn").hidden = d.status === "completed";
      loadRuns();
      break;
    }
  }
}

/* ---------- wiring ---------- */

function follow(runId) {
  if (es) es.close();
  currentRun = runId;
  reset();
  es = new EventSource(`/api/runs/${runId}/events`);
  es.onmessage = (m) => render(JSON.parse(m.data));
  es.onerror = () => {};
}

async function loadRuns() {
  const runs = await fetch("/api/runs").then((r) => r.json());
  const strip = $("runs-strip");
  strip.innerHTML = "";
  for (const r of runs.slice(0, 12)) {
    const b = document.createElement("button");
    b.className = "run-pill" + (r.id === currentRun ? " sel" : "");
    b.textContent = `${r.id.replace("run-", "").slice(0, 19)} · ${r.outcome ?? r.status}`;
    b.title = `${r.id}${r.mission ? "\n" + r.mission : ""}\n(click to follow; full id also shown in the Traverse header)`;
    b.onclick = () => follow(r.id);
    strip.appendChild(b);
  }
}

$("start-btn").addEventListener("click", async () => {
  const demo = $("demo-check").checked;
  const body = {
    mission: $("mission-input").value.trim() || "Document how to kick off a New Work Request in the demo app.",
    demo,
  };
  if (!demo) {
    body.target = $("target-input").value.trim();
    body.repoPath = $("repo-input").value.trim() || undefined;
    body.publication = $("pub-select").value || undefined;
    if (!body.target) { $("status-msg").textContent = "Live runs need a target URL."; return; }
  }
  const res = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) { $("status-msg").textContent = out.error; return; }
  $("start-btn").disabled = true;
  $("abort-btn").hidden = false;
  if (!demo) {
    $("resume-btn").hidden = false;
    $("status-msg").textContent = "A browser window opened on this machine — log into the target there, then hand off.";
  }
  follow(out.runId);
  loadRuns();
});

$("resume-btn").addEventListener("click", async () => {
  await fetch(`/api/runs/${currentRun}/resume`, { method: "POST" });
  $("resume-btn").hidden = true;
  $("status-msg").textContent = "Agent has the controls.";
});

$("abort-btn").addEventListener("click", async () => {
  await fetch(`/api/runs/${currentRun}/abort`, { method: "POST" });
});

$("handoff-btn").addEventListener("click", async () => {
  const publication = $("pub-select").value;
  const msg = $("order-msg");
  if (!publication) { msg.textContent = "Pick a publication in the dropdown up top first."; return; }
  $("handoff-btn").disabled = true;
  msg.textContent = `Compiling and submitting to "${publication}"…`;
  const res = await fetch(`/api/runs/${currentRun}/handoff`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publication }),
  });
  const out = await res.json();
  if (!res.ok) {
    msg.textContent = out.error;
    $("handoff-btn").disabled = false;
    return;
  }
  msg.textContent = `Submitted${out.ref ? ` → ${out.ref}` : ""}.`;
});

$("continue-btn").addEventListener("click", async () => {
  const msg = $("order-msg");
  msg.textContent = "Resuming mission in a new run…";
  const res = await fetch(`/api/runs/${currentRun}/continue`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ publication: $("pub-select").value || undefined }),
  });
  const out = await res.json();
  if (!res.ok) { msg.textContent = out.error; return; }
  $("start-btn").disabled = true;
  $("abort-btn").hidden = false;
  $("resume-btn").hidden = false;
  $("status-msg").textContent = "Resumed run started — log into the browser window that opened, then hand off.";
  follow(out.runId);
  loadRuns();
});

async function loadHandoffTargets() {
  try {
    const { targets, reason } = await fetch("/api/handoff/targets").then((r) => r.json());
    const sel = $("pub-select");
    for (const name of targets) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = `Hand off → ${name}`;
      sel.appendChild(opt);
    }
    if (!targets.length && reason) sel.title = `Handoff unavailable: ${reason}`;
  } catch { /* runtime without handoff config — selector stays explore-only */ }
}

loadHandoffTargets();
loadRuns();
