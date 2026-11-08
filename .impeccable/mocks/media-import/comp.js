/* Standalone design study. No requests, storage, uploads or daemon integration. */
const query = new URLSearchParams(location.search);
const state = ["entry", "selected", "queued"].includes(query.get("state")) ? query.get("state") : "selected";
const url = next => `comp.html?state=${next}`;
const back = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18"/></svg>';
const isCapture = state === "entry";
const shell = `<header class="shell"><div class="header-inner"><div class="identity">${!isCapture ? `<a class="back" href="${url("entry")}" aria-label="Back to Capture" title="Back to Capture">${back}</a>` : ""}<div class="brand"><a class="wordmark" href="workflow.html?view=explore">thoughtloom</a><p class="tagline">Where ideas take shape.</p></div></div><nav class="nav" aria-label="Main navigation"><a href="workflow.html?view=explore">Explore</a><a href="${url("entry")}" aria-current="page">Capture</a><span class="reserved">Settings <small>Reserved</small></span></nav></div></header>`;
const choiceLink = (kind, description, destination) => `<a class="choice-link" href="${destination}"${kind === "Markdown" ? ' data-markdown' : ""}><strong>${kind}</strong><p>${description}</p></a>`;
const imageChoice = destination => choiceLink("Image or PDF", "Keep one original file and request an AI interpretation.", destination);
const markdownChoice = () => choiceLink("Markdown", "Bring in original words without rewriting them.", "review.html#markdown");

function capture() {
  const choices = `<div class="popover" id="import-choices" aria-label="Import choices">${imageChoice(url("selected"))}${markdownChoice()}<p class="small">Your Capture draft stays here.</p></div>`;
  return `<section class="capture"><header class="intro"><div class="heading-row"><h1><img src="../../../apps/web/public/glyphs/sprout.svg" alt="" aria-hidden="true">Capture</h1><button class="text-action" id="import-trigger" type="button" aria-expanded="true" aria-controls="import-choices">Import</button>${choices}</div><p>Write or paste a thought.</p></header><form><div class="field"><label for="thought">Thought</label><textarea id="thought">An idea can be useful before I know how to name it.</textarea></div><div class="field"><label for="capture-title">Title <span>(optional)</span></label><input id="capture-title"></div><div class="form-actions"><button class="button primary" type="button" data-inert>Save</button></div></form></section>`;
}
const fileRow = (change = true) => `<div class="file-row"><div><p class="file-name">workshop-notes.pdf</p><p class="file-facts">PDF · 842 KB</p></div>${change ? `<button class="text-action" type="button" data-change>Change file</button>` : ""}</div>`;
const clarification = `<div class="field"><label for="clarification">Clarification <span>(optional)</span></label><textarea id="clarification" aria-describedby="clarification-help">Summarize the main ideas and highlight the questions we left open.</textarea><p class="small" id="clarification-help">Leave blank to request a summary. Your wording is saved separately from the file.</p></div>`;
const formActions = `<div class="form-actions"><p class="small">Nothing is sent until you choose Import file.</p><button class="button primary" type="submit">Import file</button></div>`;
const how = `<div class="how"><p>The original stays unchanged. Any AI interpretation is saved as a separate thought.</p><p class="small">PNG, JPEG, GIF, WebP or PDF. One file at a time.</p></div>`;
const rail = (saved = false) => `<aside class="source-rail" aria-label="${saved ? "Retained original" : "Selected file"}"><h2>${saved ? "Retained original" : "Selected file"}</h2>${fileRow(!saved)}<p class="by-source">Original authorship unverified</p>${!saved ? '<p class="small">The file is not uploaded yet.</p>' : ""}</aside>`;

function selected() {
  const intro = `<header class="intro"><h1>Import image or PDF</h1><p>Keep the original. Let AI help you make sense of it.</p></header>`;
  return `<section>${intro}<div class="split">${rail()}<div><form class="media-form">${clarification}${formActions}</form>${how}</div></div></section>`;
}
const retained = `<div class="retained" role="status"><h2>Original saved</h2><p>Your file and clarification are saved. The AI interpretation is separate and is still queued.</p></div>`;
const savedClarification = `<div class="clarification-read"><h3>Your clarification</h3><p>Summarize the main ideas and highlight the questions we left open.</p></div>`;
const run = `<section class="run" aria-label="Interpretation status"><div class="run-head"><h2>Interpretation · Queued</h2><p class="small">Run study-weave-01</p></div><p>The original is available now. No AI interpretation has been recorded yet.</p><div class="actions"><button class="text-action" type="button" data-check>Check this run</button><button class="text-action" type="button" data-stop>Stop</button></div><p class="small" data-run-notice hidden></p></section>`;
const afterSave = `<div class="actions after-save"><a class="button primary" href="workflow.html?view=source&state=queued">Open source idea</a><a class="text-action" href="${url("selected")}">Import another file</a></div>`;
function queued() {
  const intro = `<header class="intro"><h1>Import image or PDF</h1></header>`;
  return `<section>${intro}${retained}<div class="split-saved">${rail(true)}<div class="saved-summary">${savedClarification}${run}${afterSave}</div></div></section>`;
}
const content = state === "entry" ? capture() : state === "queued" ? queued() : selected();
const currentCapture = isCapture;
const scene = currentCapture ? `<div class="capture-scene"><div class="capture-canopy" aria-hidden="true"><img src="../../../apps/web/public/backgrounds/capture-canopy.png" width="392" height="588" alt="" aria-hidden="true" draggable="false"></div>${content}</div>` : content;
document.querySelector("#app").innerHTML = `${shell}<main id="main">${scene}</main><footer class="study-note">Approved B design study · Illustrative file and draft · No files are sent.</footer>`;
document.querySelectorAll("form").forEach(form => form.addEventListener("submit", event => { event.preventDefault(); location.href = url("queued"); }));
document.querySelector("#import-trigger")?.addEventListener("click", event => {
  const trigger = event.currentTarget, panel = document.querySelector("#import-choices");
  panel.hidden = !panel.hidden;
  trigger.setAttribute("aria-expanded", String(!panel.hidden));
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && document.querySelector("#import-choices:not([hidden])")) {
    document.querySelector("#import-choices").hidden = true;
    document.querySelector("#import-trigger").setAttribute("aria-expanded", "false");
    document.querySelector("#import-trigger").focus();
  }
});
document.querySelectorAll("[data-markdown]").forEach(link => link.addEventListener("click", event => {
  event.preventDefault(); alert("This choice opens the existing Markdown import workflow. It is unchanged by this design study.");
}));
document.querySelector("[data-change]")?.addEventListener("click", () => alert("Design study: choose a different single file here. No file picker or upload is connected."));
document.querySelectorAll("[data-inert]").forEach(control => control.addEventListener("click", event => { event.preventDefault(); }));
for (const action of ["check", "stop"]) document.querySelector(`[data-${action}]`)?.addEventListener("click", () => {
  const notice = document.querySelector("[data-run-notice]"); notice.hidden = false;
  notice.textContent = action === "check" ? "Design study: Check reads this same known run. No request was sent." : "Design study: Stop requests cancellation of this known run. It does not guarantee an immediate native stop. No request was sent.";
});
