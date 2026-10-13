import { api } from "./api.js";
import { Player, PRESET_SIZE } from "./player.js";
import { TimelineView, fmt } from "./timeline.js";

const $ = (id) => document.getElementById(id);
const state = { health: null, drive: null, project: null, jobs: new Map(), undo: [], saveTimer: null, es: null, tab: "media", selected: null };

// ---------------- toast ----------------
let toastTimer;
function toast(msg, err = false) {
  const root = $("toastRoot");
  root.innerHTML = `<div class="toast ${err ? "err" : ""}"></div>`;
  root.firstChild.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (root.innerHTML = ""), err ? 6000 : 2600);
}

// ---------------- routing ----------------
async function route() {
  const m = location.hash.match(/^#\/p\/(\w+)/);
  if (m) await openProject(m[1]);
  else await showProjects();
}
window.addEventListener("hashchange", route);

// ---------------- projects screen ----------------
async function showProjects() {
  closeProject();
  $("editor").hidden = true;
  $("projects").hidden = false;
  const [health, drive, projects] = await Promise.all([api.health(), api.driveStatus().catch(() => null), api.projects()]);
  state.health = health;
  state.drive = drive;
  $("statusLine").innerHTML = [
    `<span class="pill ${health.anthropic ? "ok" : "bad"}">${health.mockAi ? "Claude: mock mode" : health.anthropic ? `Claude: ready` : "Claude: add your API key in Settings"}</span>`,
    `<span class="pill ${drive?.connected ? "ok" : "warn"}">${drive?.connected ? `Drive online: ${drive.user?.emailAddress || "connected"}` : "Drive: use your Drive folder on this PC"}</span>`,
    `<span class="pill">${health.concurrency} render lanes</span>`,
    drive?.configured && !drive.connected ? `<a class="btn sm" href="/auth/google">Connect Google Drive online</a>` : "",
  ].join("");
  if (!health.anthropic && !sessionStorage.getItem("sonika-setup-shown")) {
    sessionStorage.setItem("sonika-setup-shown", "1");
    openSettings(true);
  }
  const cards = $("projectCards");
  cards.innerHTML = "";
  const nw = document.createElement("div");
  nw.className = "card new";
  nw.textContent = "＋ New project";
  nw.onclick = newProject;
  cards.appendChild(nw);
  for (const p of projects) {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = `<div><div class="name"></div><div class="meta">${p.mediaCount} files · ${p.renders} renders</div></div><div class="meta">${new Date(p.updatedAt).toLocaleString()}</div>`;
    c.querySelector(".name").textContent = p.name;
    c.onclick = () => (location.hash = `#/p/${p.id}`);
    cards.appendChild(c);
  }
}

async function newProject() {
  const body = await modal({
    title: "New project",
    body: `<div class="field"><label>Name</label><input type="text" id="npName" placeholder="Listing reel — 12 Main St" /></div>
      <div class="fields2" style="margin-top:10px">
        <div class="field"><label>Format</label><select id="npAspect"><option value="16:9">16:9 · 1920×1080</option><option value="9:16">9:16 · 1080×1920 (Reels / Shorts)</option><option value="1:1">1:1 · 1080×1080</option><option value="4:5">4:5 · 1080×1350</option></select></div>
        <div class="field"><label>Frame rate</label><select id="npFps"><option>30</option><option>24</option><option>25</option><option>60</option></select></div>
      </div>`,
    ok: "Create",
    collect: () => ({ name: $("npName").value, aspect: $("npAspect").value, fps: Number($("npFps").value) }),
  });
  if (!body) return;
  const p = await api.createProject(body);
  location.hash = `#/p/${p.id}`;
}
$("newProjectBtn").onclick = newProject;
$("settingsBtn").onclick = () => openSettings(false);

async function openSettings(firstRun) {
  const st = await api.settings();
  const roots = await api.localRoots().catch(() => ({ driveCandidates: [] }));
  const body = `
    ${firstRun ? `<p style="margin:0 0 12px"><b>Welcome to Sonika.</b> One thing to set up: Claude needs an API key to edit for you. Everything else is optional.</p>` : ""}
    <h3>1 · Claude API key</h3>
    <p class="hint">Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com → API keys</a> (create key, copy, paste below). Model: ${esc(st.model)}.</p>
    <input type="password" id="stKey" placeholder="${st.anthropicKeySet ? `Saved: ${esc(st.anthropicKeyHint)} — paste a new key to replace it` : "sk-ant-…"}" />
    <h3 style="margin-top:16px">2 · Google Drive folder on this PC (recommended)</h3>
    <p class="hint">If Google Drive for desktop is installed, Sonika reads your footage straight from that folder. ${roots.driveCandidates?.length ? `Found: ${roots.driveCandidates.map(esc).join(", ")}` : "No Drive folder found automatically; type the path if you have one (e.g. G:\\My Drive)."}</p>
    <input type="text" id="stDrive" value="${esc(st.localDriveFolder || roots.driveCandidates?.[0] || "")}" placeholder="G:\\My Drive" />
    <details style="margin-top:16px"><summary class="hint" style="cursor:pointer">Advanced: Google Drive online (OAuth) — only needed when Sonika runs on a server, not on your PC</summary>
      <div class="fields2" style="margin-top:8px">
        <div class="field"><label>Client ID</label><input type="text" id="stGid" value="${esc(st.googleClientId)}" /></div>
        <div class="field"><label>Client secret</label><input type="password" id="stGsec" placeholder="${st.googleClientSecretSet ? "saved" : ""}" /></div>
      </div>
      <div class="field" style="margin-top:8px"><label>Redirect URI (add this in Google Cloud Console)</label><input type="text" id="stGuri" value="${esc(st.googleRedirectUri)}" /></div>
    </details>`;
  const r = await modal({
    title: "Settings",
    body,
    ok: "Save",
    collect: () => ({ anthropicApiKey: $("stKey").value || undefined, localDriveFolder: $("stDrive").value, googleClientId: $("stGid").value, googleClientSecret: $("stGsec").value || undefined, googleRedirectUri: $("stGuri").value }),
  });
  if (!r) return;
  try {
    await api.saveSettings(r);
    toast("Settings saved");
    state.health = null;
    if (!$("projects").hidden) showProjects();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------- editor ----------------
let player, tl;

async function openProject(id) {
  let project;
  try {
    project = await api.project(id);
  } catch (err) {
    toast(err.message, true);
    location.hash = "";
    return;
  }
  state.project = project;
  state.undo = [];
  state.selected = null;
  $("projects").hidden = true;
  $("editor").hidden = false;
  if (!player) initEditor();
  player.setProject(project);
  tl.selected = null;
  tl.render();
  tl.fit();
  renderAll();
  connectEvents(id);
  state.jobs.clear();
  for (const j of await api.jobs(id)) state.jobs.set(j.id, j);
  renderJobs();
  if (!state.drive) state.drive = await api.driveStatus().catch(() => null);
  if (!state.health) state.health = await api.health();
  document.title = `${project.name} — Sonika`;
}

function closeProject() {
  if (state.es) state.es.close();
  state.es = null;
  if (player) player.pause();
  state.project = null;
}

function initEditor() {
  player = new Player({
    frame: $("frame"),
    vidA: $("vidA"),
    vidB: $("vidB"),
    imgEl: $("imgEl"),
    overlay: $("overlay"),
    onTime: (t) => {
      $("tCur").textContent = fmt(t);
      $("scrub").value = player.duration ? Math.round((t / player.duration) * 1000) : 0;
      tl.updatePlayhead(t);
      if (player.playing) tl.follow(t);
    },
    onEnded: () => ($("playBtn").textContent = "▶"),
  });
  tl = new TimelineView({
    scrollEl: $("tlScroll"),
    innerEl: $("tlInner"),
    rulerEl: $("ruler"),
    tracksEl: $("tracks"),
    playheadEl: $("playhead"),
    snaplineEl: $("snapline"),
    getProject: () => state.project,
    getTime: () => player.t,
    onChange: (label, fn) => mutate(label, fn),
    onSelect: (sel) => {
      state.selected = sel;
      renderInspector();
    },
    onSeek: (t) => player.seek(t),
    onDrop: (mediaId, trackId, t) => addMediaToTrack(mediaId, trackId, t),
    toast,
  });

  $("backBtn").onclick = () => (location.hash = "");
  $("projectName").onchange = async () => {
    const p = await api.renameProject(state.project.id, $("projectName").value);
    state.project.name = p.name;
    document.title = `${p.name} — Sonika`;
  };
  $("playBtn").onclick = togglePlay;
  $("toStart").onclick = () => player.seek(0);
  $("scrub").oninput = () => player.seek((($("scrub").value / 1000) * player.duration) || 0);
  $("zoom").oninput = () => tl.setZoom(Number($("zoom").value));
  $("fitBtn").onclick = () => {
    tl.fit();
    $("zoom").value = tl.pps;
  };
  $("addTextBtn").onclick = () => addText(player.t);
  $("splitBtn").onclick = splitSelected;
  $("deleteBtn").onclick = deleteSelected;
  $("undoBtn").onclick = undo;
  $("closeGapsBtn").onclick = closeGaps;
  $("renderPreviewBtn").onclick = () => startRender("preview");
  $("renderFinalBtn").onclick = () => startRender("final");
  $("historyBtn").onclick = showHistory;
  for (const b of document.querySelectorAll(".panel.left .tabs button")) b.onclick = () => setTab(b.dataset.tab);
  $("uploadBtn").onclick = () => $("fileInput").click();
  $("fileInput").onchange = async () => {
    if (!$("fileInput").files.length) return;
    try {
      const { jobs } = await api.upload(state.project.id, $("fileInput").files);
      for (const j of jobs) state.jobs.set(j.id, j);
      renderJobs();
      toast(`Uploading ${jobs.length} file${jobs.length > 1 ? "s" : ""}`);
    } catch (err) {
      toast(err.message, true);
    }
    $("fileInput").value = "";
  };
  $("driveBtn").onclick = openDriveBrowser;
  $("localBtn").onclick = openLocalBrowser;
  $("driveLinkBtn").onclick = async () => {
    const link = $("driveLink").value.trim();
    if (!link) return;
    try {
      const { jobs } = await api.importDrive(state.project.id, { links: [link] });
      for (const j of jobs) state.jobs.set(j.id, j);
      renderJobs();
      $("driveLink").value = "";
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("planBtn").onclick = async () => {
    try {
      const { job } = await api.plan(state.project.id, $("brief").value);
      state.jobs.set(job.id, job);
      renderJobs();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("reviseBtn").onclick = sendInstruction;
  $("instruction").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendInstruction();
  });
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", () => player?.resize());
}

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll(".panel.left .tabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const t of ["media", "claude", "renders"]) $(`tab-${t}`).hidden = t !== tab;
}

function togglePlay() {
  player.toggle();
  $("playBtn").textContent = player.playing ? "❚❚" : "▶";
}

function onKey(e) {
  if (!state.project || $("editor").hidden) return;
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (typing) return;
  if (e.code === "Space") {
    e.preventDefault();
    togglePlay();
  } else if (e.key === "s" || e.key === "S") splitSelected();
  else if (e.key === "t" || e.key === "T") addText(player.t);
  else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
  else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
    e.preventDefault();
    undo();
  } else if (e.key === "ArrowLeft") player.seek(player.t - (e.shiftKey ? 1 : 1 / state.project.settings.fps));
  else if (e.key === "ArrowRight") player.seek(player.t + (e.shiftKey ? 1 : 1 / state.project.settings.fps));
  else if (e.key === "Home") player.seek(0);
  else if (e.key === "End") player.seek(player.duration);
  else if (e.key === "Escape") tl.select(null, null);
}

// ---------------- rendering panels ----------------
function renderAll() {
  const p = state.project;
  $("projectName").value = p.name;
  $("projectMeta").textContent = `${p.settings.width}×${p.settings.height} · ${p.settings.fps}fps`;
  $("revisionPill").textContent = `r${p.revision}`;
  $("tTot").textContent = fmt(player.duration);
  $("tlInfo").textContent = `${fmt(player.duration)} · ${p.timeline.tracks.reduce((a, t) => a + t.clips.length, 0)} clips`;
  $("frameEmpty").hidden = player.duration > 0;
  renderMedia();
  renderChat();
  renderRenders();
  renderInspector();
}

function renderMedia() {
  const grid = $("mediaGrid");
  grid.innerHTML = "";
  for (const m of state.project.media) {
    const c = document.createElement("div");
    c.className = "mcard";
    c.draggable = true;
    const thumb = m.poster ? `style="background-image:url(${api.fileUrl(state.project.id, "thumbs", m.poster)})"` : "";
    c.innerHTML = `<div class="thumb" ${thumb}>${m.poster ? "" : m.kind === "audio" ? "♫" : "▣"}</div>
      <div class="info"><div class="n"></div><div class="d"><span>${m.kind === "image" ? "image" : fmt(m.duration)}</span><span>${m.width ? `${m.width}×${m.height}` : ""}${m.transcript ? " · T" : ""}</span></div></div>
      <div class="acts"><button class="btn sm" data-a="add" title="Add at playhead">＋</button><button class="btn sm" data-a="tx" title="Transcript">T</button><button class="btn sm danger" data-a="del" title="Remove">✕</button></div>`;
    c.querySelector(".n").textContent = m.name;
    c.title = `${m.name}\n${m.scenes?.length || 0} scene changes · ${m.speech?.length || 0} speech ranges`;
    c.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/sonika-media", m.id));
    c.querySelector('[data-a="add"]').onclick = () => addMediaToTrack(m.id, m.kind === "audio" ? "A1" : "V1", player.t);
    c.querySelector('[data-a="tx"]').onclick = () => editTranscript(m);
    c.querySelector('[data-a="del"]').onclick = () => removeMedia(m);
    grid.appendChild(c);
  }
}

function renderChat() {
  const chat = $("chat");
  chat.innerHTML = "";
  for (const m of state.project.chat) {
    const d = document.createElement("div");
    d.className = `msg ${m.role}`;
    d.innerHTML = `<div class="who">${m.role === "claude" ? "Claude" : "You"}</div>`;
    d.appendChild(document.createTextNode(m.text));
    chat.appendChild(d);
  }
  $("briefBox").hidden = state.project.chat.length > 0 && player.duration > 0;
}

function renderRenders() {
  const list = $("renderList");
  list.innerHTML = "";
  for (const r of state.project.renders) {
    const d = document.createElement("div");
    d.className = "render";
    const url = api.fileUrl(state.project.id, "renders", r.file);
    d.innerHTML = `<video controls preload="metadata" src="${url}"></video>
      <div class="info"><div class="row"><b>${r.quality}</b><span class="faint">r${r.revision} · ${r.width}×${r.height} · ${fmt(r.duration)}</span></div>
      <div class="row wrap" style="margin-top:6px"><a class="btn sm" href="${url}" download>Download</a><button class="btn sm" data-a="drive">${r.driveLink ? "Re-send to Drive" : "Send to Drive"}</button>${r.driveLink ? `<a class="btn sm ghost" href="${r.driveLink}" target="_blank">Open in Drive</a>` : ""}<span class="grow"></span><button class="btn sm ghost danger" data-a="del">✕</button></div></div>`;
    d.querySelector('[data-a="drive"]').onclick = async () => {
      if (!state.drive?.connected) return toast("Connect Google Drive first (Media tab → Google Drive)", true);
      const { job } = await api.uploadRender(state.project.id, r.id);
      state.jobs.set(job.id, job);
      renderJobs();
    };
    d.querySelector('[data-a="del"]').onclick = async () => {
      if (!(await confirmModal("Delete this render?"))) return;
      state.project = await api.deleteRender(state.project.id, r.id);
      renderRenders();
    };
    list.appendChild(d);
  }
  if (!state.project.renders.length) list.innerHTML = `<p class="hint">No renders yet. “Render preview” is a fast 540p pass from the proxies; “Render final” uses the originals at full resolution.</p>`;
}

function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  const card = (j) => `<div class="job ${j.status}"><div class="row"><span class="grow">${j.kind === "ingest" ? "Import" : j.kind === "render" ? "Render" : j.kind === "upload" ? "Upload" : "Claude"} · ${esc(j.label || "")}</span><span class="faint">${j.status === "done" ? "done" : j.status === "failed" ? "failed" : `${Math.round(j.progress * 100)}%`}</span></div>
    ${j.status === "running" || j.status === "queued" ? `<div class="faint" style="font-size:11px">${esc(j.message || "queued")}</div>` : ""}
    <div class="bar"><i style="width:${Math.round(j.progress * 100)}%"></i></div>${j.error ? `<div class="err">${esc(j.error)}</div>` : ""}</div>`;
  const show = (j) => j.status !== "done" || Date.now() - j.createdAt < 60000;
  $("ingestJobs").innerHTML = jobs.filter((j) => j.kind === "ingest" && show(j)).map(card).join("");
  $("renderJobs").innerHTML = jobs.filter((j) => (j.kind === "render" || j.kind === "upload") && show(j)).map(card).join("");
  const ai = jobs.find((j) => (j.kind === "plan" || j.kind === "revise") && (j.status === "running" || j.status === "queued"));
  const aiFailed = jobs.find((j) => (j.kind === "plan" || j.kind === "revise") && j.status === "failed" && Date.now() - j.createdAt < 120000);
  $("aiStatus").innerHTML = ai ? `<div class="thinking"><i></i>${esc(ai.message || "Claude is thinking")}</div>` : aiFailed ? `<div class="job failed"><div class="err">${esc(aiFailed.error)}</div></div>` : "";
  $("planBtn").disabled = !!ai;
  $("reviseBtn").disabled = !!ai;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------------- inspector ----------------
function findSelected() {
  if (!state.selected) return null;
  const track = state.project.timeline.tracks.find((t) => t.id === state.selected.trackId);
  const clip = track?.clips.find((c) => c.id === state.selected.clipId);
  return clip ? { track, clip } : null;
}

function renderInspector() {
  const box = $("inspector");
  const sel = findSelected();
  if (!sel) {
    box.innerHTML = `<h3>Nothing selected</h3><p class="hint">Click a clip on the timeline to edit it.</p>
      <h3 style="margin-top:14px">Keys</h3>
      <p class="hint"><span class="kbd">Space</span> play · <span class="kbd">S</span> split at playhead · <span class="kbd">T</span> add text · <span class="kbd">Del</span> remove · <span class="kbd">Ctrl+Z</span> undo · <span class="kbd">←→</span> frame step (shift = 1s)</p>
      <p class="hint">Drag a clip to move it, pull its edges to trim. Edges snap to other clips and the playhead.</p>`;
    return;
  }
  const { track, clip } = sel;
  const m = state.project.media.find((x) => x.id === clip.mediaId);
  const f = (label, inner) => `<div class="field"><label>${label}</label>${inner}</div>`;
  const num = (key, step = 0.01, min = 0, max = 100000) => `<input type="number" data-k="${key}" value="${clip[key] ?? ""}" step="${step}" min="${min}" max="${max}" />`;
  let html = `<h3>${track.kind} clip</h3>`;
  if (track.kind === "video") {
    html += `<div class="hint" style="margin:6px 0 10px">${esc(m?.name || "")}</div>`;
    html += f("Label", `<input type="text" data-k="label" value="${esc(clip.label || "")}" />`);
    html += `<div class="fields2">${f("Start (s)", num("start"))}${f("Duration (s)", num("duration", 0.01, 0.1))}</div>`;
    if (m?.kind !== "image") html += `<div class="fields2">${f("Source in (s)", num("in"))}${f("Speed", num("speed", 0.05, 0.25, 4))}</div>`;
    html += `<div class="fields2">${f("Volume", `<input type="range" data-k="volume" min="0" max="2" step="0.05" value="${clip.volume ?? 1}" />`)}${f("Mute", `<select data-k="muted"><option value="false" ${!clip.muted ? "selected" : ""}>no</option><option value="true" ${clip.muted ? "selected" : ""}>yes</option></select>`)}</div>`;
    html += `<div class="fields2">${f("Fit", `<select data-k="fit"><option value="cover" ${clip.fit === "cover" ? "selected" : ""}>fill (crop)</option><option value="contain" ${clip.fit === "contain" ? "selected" : ""}>fit (letterbox)</option></select>`)}${m?.kind === "image" ? f("Ken Burns", `<select data-k="kenBurns"><option value="false" ${!clip.kenBurns ? "selected" : ""}>off</option><option value="true" ${clip.kenBurns ? "selected" : ""}>slow zoom</option></select>`) : ""}</div>`;
    html += `<div class="fields2">${f("Transition in", `<select data-k="transitionIn.type"><option value="cut" ${clip.transitionIn.type === "cut" ? "selected" : ""}>cut</option><option value="dissolve" ${clip.transitionIn.type === "dissolve" ? "selected" : ""}>dissolve</option><option value="fade" ${clip.transitionIn.type === "fade" ? "selected" : ""}>fade (black)</option></select>`)}${f("Transition (s)", `<input type="number" data-k="transitionIn.duration" value="${clip.transitionIn.duration}" step="0.1" min="0.1" max="3" />`)}</div>`;
    html += f("Fade out (s)", num("fadeOut", 0.1, 0, 5));
  } else if (track.kind === "text") {
    html += f("Text", `<textarea data-k="text">${esc(clip.text)}</textarea>`);
    html += `<div class="fields2">${f("Start (s)", num("start"))}${f("Duration (s)", num("duration", 0.01, 0.1))}</div>`;
    html += `<div class="fields2">${f("Style", `<select data-k="preset">${Object.keys(PRESET_SIZE).map((p) => `<option ${clip.preset === p ? "selected" : ""}>${p}</option>`).join("")}</select>`)}${f("Position", `<select data-k="position">${["top", "center", "bottom"].map((p) => `<option ${clip.position === p ? "selected" : ""}>${p}</option>`).join("")}</select>`)}</div>`;
    html += `<div class="fields2">${f("Align", `<select data-k="align"><option ${clip.align === "center" ? "selected" : ""}>center</option><option ${clip.align === "left" ? "selected" : ""}>left</option></select>`)}${f("Animation", `<select data-k="animation">${["fade", "pop", "none"].map((p) => `<option ${clip.animation === p ? "selected" : ""}>${p}</option>`).join("")}</select>`)}</div>`;
    html += `<div class="fields2">${f("Color", `<input type="color" data-k="color" value="${clip.color}" />`)}${f("Box", `<div class="row"><select data-k="box" style="width:70px"><option value="true" ${clip.box ? "selected" : ""}>on</option><option value="false" ${!clip.box ? "selected" : ""}>off</option></select><input type="color" data-k="boxColor" value="${clip.boxColor}" /></div>`)}</div>`;
  } else {
    html += `<div class="hint" style="margin:6px 0 10px">${esc(m?.name || "")}</div>`;
    html += `<div class="fields2">${f("Start (s)", num("start"))}${f("Duration (s)", num("duration", 0.01, 0.1))}</div>`;
    html += `<div class="fields2">${f("Source in (s)", num("in"))}${f("Volume", `<input type="range" data-k="volume" min="0" max="1.5" step="0.05" value="${clip.volume}" />`)}</div>`;
    html += `<div class="fields2">${f("Fade in (s)", num("fadeIn", 0.1, 0, 10))}${f("Fade out (s)", num("fadeOut", 0.1, 0, 10))}</div>`;
  }
  html += `<div class="row" style="margin-top:14px"><button class="btn sm" id="insSplit">Split at playhead</button><button class="btn sm danger" id="insDelete">Remove</button></div>`;
  box.innerHTML = html;
  for (const input of box.querySelectorAll("[data-k]")) {
    const ev = input.type === "range" || input.type === "color" ? "input" : "change";
    input.addEventListener(ev, () => applyField(input.dataset.k, input));
  }
  $("insSplit").onclick = splitSelected;
  $("insDelete").onclick = deleteSelected;
}

function applyField(key, input) {
  let v = input.value;
  if (input.type === "number" || input.type === "range") v = Number(v);
  if (v === "true") v = true;
  if (v === "false") v = false;
  mutate(`edit ${key}`, (tlData) => {
    const track = tlData.tracks.find((t) => t.id === state.selected.trackId);
    const clip = track.clips.find((c) => c.id === state.selected.clipId);
    if (key.includes(".")) {
      const [a, b] = key.split(".");
      clip[a] = { ...clip[a], [b]: v };
    } else clip[key] = v;
    if (key === "start" || key === "duration") track.clips.sort((a, b) => a.start - b.start);
  }, { coalesce: key, rerenderInspector: input.type === "number" || input.tagName === "SELECT" });
}

// ---------------- mutations / save ----------------
function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function mutate(label, fn, { coalesce = null, rerenderInspector = true } = {}) {
  const before = clone(state.project.timeline);
  const last = state.undo[state.undo.length - 1];
  if (!(coalesce && last && last.coalesce === coalesce && Date.now() - last.at < 1500)) {
    state.undo.push({ timeline: before, label, coalesce, at: Date.now() });
    if (state.undo.length > 100) state.undo.shift();
  } else last.at = Date.now();
  const work = clone(state.project.timeline);
  fn(work);
  state.project.timeline = work;
  afterTimelineChange(label, rerenderInspector);
}

function afterTimelineChange(label, rerenderInspector = true) {
  player.setTimeline(state.project.timeline);
  tl.render();
  renderAll();
  if (!rerenderInspector) {
    /* keep focus in the inspector input */
  }
  scheduleSave(label);
}

function scheduleSave(label) {
  $("saveState").textContent = "unsaved";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => save(label), 500);
}

async function save(label) {
  const p = state.project;
  if (!p) return;
  $("saveState").textContent = "saving…";
  try {
    const fresh = await api.saveTimeline(p.id, p.timeline, p.revision, label);
    if (state.project !== p) return;
    p.revision = fresh.revision;
    p.timeline = fresh.timeline;
    p.history = fresh.history;
    $("revisionPill").textContent = `r${p.revision}`;
    $("saveState").textContent = "saved";
    // Server may have filled ids/clamped values: re-sync view without a new undo entry.
    player.setTimeline(p.timeline);
    tl.render();
  } catch (err) {
    $("saveState").textContent = "save failed";
    if (err.status === 409) {
      toast("The timeline changed elsewhere (Claude or another tab). Reloading.", true);
      await reloadProject();
    } else toast(err.message, true);
  }
}

async function reloadProject({ resetSelection = false } = {}) {
  const fresh = await api.project(state.project.id);
  state.project = fresh;
  if (resetSelection) {
    state.selected = null;
    tl.selected = null;
  }
  player.setProject(fresh);
  tl.render();
  renderAll();
}

function undo() {
  const entry = state.undo.pop();
  if (!entry) return toast("Nothing to undo");
  state.project.timeline = entry.timeline;
  afterTimelineChange(`undo ${entry.label}`);
}

// ---------------- clip operations ----------------
function trackEnd(track) {
  return track.clips.reduce((e, c) => Math.max(e, c.start + c.duration), 0);
}

function addMediaToTrack(mediaId, trackId, t) {
  const m = state.project.media.find((x) => x.id === mediaId);
  if (!m) return;
  const kindWanted = m.kind === "audio" ? "audio" : "video";
  mutate(`add ${m.name}`, (tlData) => {
    let track = tlData.tracks.find((x) => x.id === trackId);
    if (!track || track.kind !== kindWanted) track = tlData.tracks.find((x) => x.kind === kindWanted);
    const dur = m.kind === "image" ? 3 : Math.min(m.duration, kindWanted === "audio" ? 60 : m.duration);
    let start = Math.max(0, t);
    const overlaps = (s, d) => track.clips.some((c) => s < c.start + c.duration && s + d > c.start);
    if (overlaps(start, dur)) start = trackEnd(track);
    const clip = kindWanted === "audio"
      ? { id: cid(), mediaId, start, duration: dur, in: 0, volume: 0.2, fadeIn: 1, fadeOut: 2 }
      : { id: cid(), mediaId, start, duration: dur, in: 0, speed: 1, volume: 1, muted: false, fit: "cover", kenBurns: false, transitionIn: { type: "cut", duration: 0.5 }, fadeOut: 0, label: "" };
    track.clips.push(clip);
    track.clips.sort((a, b) => a.start - b.start);
    state.selected = { trackId: track.id, clipId: clip.id };
    tl.selected = state.selected;
  });
}

function addText(t) {
  mutate("add text", (tlData) => {
    const track = tlData.tracks.find((x) => x.kind === "text");
    let start = Math.max(0, t);
    if (track.clips.some((c) => start < c.start + c.duration && start + 3 > c.start)) start = trackEnd(track);
    const clip = { id: cid(), text: "Your text", start, duration: 3, preset: "title", position: "center", align: "center", color: "#FFFFFF", box: true, boxColor: "#000000", animation: "fade" };
    track.clips.push(clip);
    track.clips.sort((a, b) => a.start - b.start);
    state.selected = { trackId: track.id, clipId: clip.id };
    tl.selected = state.selected;
  });
  setTimeout(() => $("inspector").querySelector("textarea")?.select(), 50);
}

function splitSelected() {
  const sel = findSelected();
  if (!sel) return toast("Select a clip to split");
  const t = player.t;
  const { track, clip } = sel;
  if (t <= clip.start + 0.05 || t >= clip.start + clip.duration - 0.05) return toast("Move the playhead inside the clip to split it");
  mutate("split", (tlData) => {
    const tr = tlData.tracks.find((x) => x.id === track.id);
    const c = tr.clips.find((x) => x.id === clip.id);
    const left = t - c.start;
    const right = { ...clone(c), id: cid(), start: t, duration: c.duration - left };
    if (track.kind !== "text") right.in = (c.in || 0) + left * (c.speed || 1);
    if (track.kind === "video") {
      right.transitionIn = { type: "cut", duration: 0.5 };
      c.fadeOut = 0;
    }
    if (track.kind === "audio") {
      c.fadeOut = 0;
      right.fadeIn = 0;
    }
    c.duration = left;
    tr.clips.push(right);
    tr.clips.sort((a, b) => a.start - b.start);
    state.selected = { trackId: tr.id, clipId: right.id };
    tl.selected = state.selected;
  });
}

function deleteSelected() {
  const sel = findSelected();
  if (!sel) return;
  mutate("delete clip", (tlData) => {
    const tr = tlData.tracks.find((x) => x.id === sel.track.id);
    tr.clips = tr.clips.filter((c) => c.id !== sel.clip.id);
  });
  state.selected = null;
  tl.selected = null;
  renderInspector();
}

function closeGaps() {
  mutate("close gaps", (tlData) => {
    const tr = tlData.tracks.find((x) => x.kind === "video");
    let cursor = 0;
    for (const c of tr.clips) {
      c.start = cursor;
      cursor += c.duration;
    }
  });
}

const cid = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------------- media actions ----------------
async function editTranscript(m) {
  const text = await modal({
    title: `Transcript — ${m.name}`,
    body: `<p class="hint">Paste the spoken words (plain text or SRT). Claude uses it to cut on sentences and to write accurate captions.</p><textarea id="txArea" style="min-height:220px"></textarea>`,
    ok: "Save",
    onOpen: () => ($("txArea").value = m.transcript || ""),
    collect: () => $("txArea").value,
  });
  if (text === null) return;
  const updated = await api.updateMedia(state.project.id, m.id, { transcript: text });
  Object.assign(m, updated);
  renderMedia();
}

async function removeMedia(m) {
  if (!(await confirmModal(`Remove ${m.name} from the project? Clips using it are removed too.`))) return;
  try {
    state.project = await api.deleteMedia(state.project.id, m.id, true);
    state.undo = [];
    player.setProject(state.project);
    tl.render();
    renderAll();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------- Claude ----------------
async function sendInstruction() {
  const text = $("instruction").value.trim();
  if (!text) return;
  if (!player.duration) return toast("Build a first cut from the brief first", true);
  try {
    const { job } = await api.revise(state.project.id, text);
    state.jobs.set(job.id, job);
    $("instruction").value = "";
    renderJobs();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------- render ----------------
async function startRender(quality) {
  if (!player.duration) return toast("The timeline is empty", true);
  if ($("saveState").textContent === "unsaved" || $("saveState").textContent === "saving…") await save("edit");
  try {
    const { job } = await api.render(state.project.id, quality);
    state.jobs.set(job.id, job);
    setTab("renders");
    renderJobs();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------- history ----------------
async function showHistory() {
  const items = await api.history(state.project.id);
  const body = items.length
    ? `<div class="dlist">${items.slice().reverse().map((h) => `<div class="ditem"><span class="pill">r${h.revision}</span><span class="n">${esc(h.label)}</span><span class="faint">${new Date(h.at).toLocaleTimeString()}</span><button class="btn sm" data-r="${h.revision}">Restore</button></div>`).join("")}</div>`
    : `<p class="hint">No checkpoints yet. Every save and every Claude edit creates one.</p>`;
  await modal({
    title: "Checkpoints",
    body,
    ok: null,
    onOpen: (root) => {
      for (const b of root.querySelectorAll("[data-r]")) {
        b.onclick = async () => {
          state.project = await api.restore(state.project.id, Number(b.dataset.r));
          state.undo = [];
          player.setProject(state.project);
          tl.render();
          renderAll();
          closeModal();
          toast(`Restored r${b.dataset.r}`);
        };
      }
    },
  });
}

// ---------------- Drive browser ----------------
async function openDriveBrowser() {
  state.drive = await api.driveStatus().catch(() => null);
  if (!state.drive?.configured) {
    return modal({ title: "Google Drive online", body: `<p>On your own PC the easy way is <b>＋ Add footage</b>, which reads your Google Drive desktop folder directly.</p><p class="hint">Online Drive access (for a server) needs a Google OAuth client id and secret: open Settings on the projects screen → Advanced.</p>`, ok: null });
  }
  if (!state.drive.connected) {
    return modal({ title: "Google Drive", body: `<p>Connect your Google account so Sonika can read your footage and write renders back.</p><a class="btn primary" href="/auth/google">Connect Google Drive</a>`, ok: null });
  }
  const sel = new Set();
  let crumbs = [{ id: "root", name: "My Drive" }];
  let q = "";
  const render = async (root) => {
    const list = root.querySelector("#dlist");
    list.innerHTML = `<p class="faint">Loading…</p>`;
    let data;
    try {
      data = await api.driveList(q ? { q } : { parent: crumbs[crumbs.length - 1].id });
    } catch (err) {
      list.innerHTML = `<p class="faint">${esc(err.message)}</p>`;
      return;
    }
    root.querySelector("#crumbs").innerHTML = q ? `Search: “${esc(q)}”` : crumbs.map((c, i) => `<button data-i="${i}">${esc(c.name)}</button>${i < crumbs.length - 1 ? " / " : ""}`).join("");
    for (const b of root.querySelectorAll("#crumbs button")) b.onclick = () => { crumbs = crumbs.slice(0, Number(b.dataset.i) + 1); render(root); };
    list.innerHTML = data.files.length ? "" : `<p class="faint">Nothing here.</p>`;
    for (const f of data.files) {
      const d = document.createElement("div");
      d.className = `ditem ${sel.has(f.id) ? "sel" : ""}`;
      d.innerHTML = `<div class="ic" ${f.thumbnail ? `style="background-image:url(${f.thumbnail})"` : ""}>${f.folder ? "📁" : f.thumbnail ? "" : f.mimeType.startsWith("audio") ? "♫" : "▣"}</div><span class="n"></span><span class="faint mono">${f.folder ? "" : f.duration ? fmt(f.duration) : f.size ? `${(f.size / 1e6).toFixed(1)} MB` : ""}</span>`;
      d.querySelector(".n").textContent = f.name;
      d.onclick = () => {
        if (f.folder) {
          q = "";
          root.querySelector("#dq").value = "";
          crumbs.push({ id: f.id, name: f.name });
          render(root);
        } else {
          sel.has(f.id) ? sel.delete(f.id) : sel.add(f.id);
          d.classList.toggle("sel");
          root.querySelector("#dcount").textContent = sel.size ? `Import ${sel.size} file${sel.size > 1 ? "s" : ""}` : "Import";
        }
      };
      list.appendChild(d);
    }
  };
  const ids = await modal({
    title: "Import from Google Drive",
    body: `<div class="row" style="margin-bottom:10px"><input type="text" id="dq" placeholder="Search Drive…" /><span class="pill ok">${esc(state.drive.user?.emailAddress || "")}</span></div><div class="crumbs" id="crumbs"></div><div class="dlist" id="dlist" style="margin-top:8px"></div>`,
    ok: "Import",
    okId: "dcount",
    onOpen: (root) => {
      let t;
      root.querySelector("#dq").oninput = (e) => {
        clearTimeout(t);
        t = setTimeout(() => { q = e.target.value.trim(); render(root); }, 350);
      };
      render(root);
    },
    collect: () => [...sel],
  });
  if (!ids?.length) return;
  const { jobs } = await api.importDrive(state.project.id, { fileIds: ids });
  for (const j of jobs) state.jobs.set(j.id, j);
  renderJobs();
  toast(`Importing ${jobs.length} file${jobs.length > 1 ? "s" : ""} from Drive`);
}

// ---------------- Local folder browser (this PC / Drive desktop folder) ----------------
async function openLocalBrowser() {
  const { roots } = await api.localRoots();
  const sel = new Map();
  let current = null;
  const render = async (root) => {
    const list = root.querySelector("#llist");
    const crumbs = root.querySelector("#lcrumbs");
    list.innerHTML = `<p class="faint">Loading…</p>`;
    if (!current) {
      crumbs.textContent = "Choose where your footage is";
      list.innerHTML = "";
      for (const r of roots) {
        const d = document.createElement("div");
        d.className = "ditem";
        d.innerHTML = `<div class="ic">${r.name.startsWith("Google Drive") ? "▲" : "📁"}</div><span class="n"></span><span class="faint mono"></span>`;
        d.querySelector(".n").textContent = r.name;
        d.querySelector(".faint").textContent = r.path;
        d.onclick = () => { current = r.path; render(root); };
        list.appendChild(d);
      }
      return;
    }
    let data;
    try {
      data = await api.localList(current);
    } catch (err) {
      list.innerHTML = `<p class="faint">${esc(err.message)}</p>`;
      return;
    }
    crumbs.innerHTML = `<button data-up="root">Places</button> / <button data-up="parent">⬆ up</button> <span class="mono">${esc(data.path)}</span>`;
    crumbs.querySelector('[data-up="root"]').onclick = () => { current = null; render(root); };
    crumbs.querySelector('[data-up="parent"]').onclick = () => { if (data.parent) { current = data.parent; render(root); } else { current = null; render(root); } };
    list.innerHTML = data.items.length ? "" : `<p class="faint">No folders or media files here.</p>`;
    const mediaFiles = data.items.filter((i) => !i.folder);
    if (mediaFiles.length > 1) {
      const all = document.createElement("div");
      all.className = "ditem";
      all.innerHTML = `<div class="ic">☑</div><span class="n">Select all ${mediaFiles.length} files in this folder</span>`;
      all.onclick = () => { for (const f of mediaFiles) sel.set(f.path, f); render(root); updateCount(root); };
      list.appendChild(all);
    }
    for (const f of data.items) {
      const d = document.createElement("div");
      d.className = `ditem ${sel.has(f.path) ? "sel" : ""}`;
      d.innerHTML = `<div class="ic">${f.folder ? "📁" : f.kind === "audio" ? "♫" : f.kind === "image" ? "🖼" : "▣"}</div><span class="n"></span><span class="faint mono">${f.folder ? "" : `${(f.size / 1e6).toFixed(1)} MB`}</span>`;
      d.querySelector(".n").textContent = f.name;
      d.onclick = () => {
        if (f.folder) { current = f.path; render(root); }
        else { sel.has(f.path) ? sel.delete(f.path) : sel.set(f.path, f); d.classList.toggle("sel"); updateCount(root); }
      };
      list.appendChild(d);
    }
  };
  const updateCount = (root) => { root.querySelector("#lcount").textContent = sel.size ? `Add ${sel.size} file${sel.size > 1 ? "s" : ""}` : "Add"; };
  const files = await modal({
    title: "Add footage from this PC",
    body: `<div class="crumbs" id="lcrumbs"></div><div class="dlist" id="llist" style="margin-top:8px"></div>`,
    ok: "Add",
    okId: "lcount",
    onOpen: (root) => render(root),
    collect: () => [...sel.keys()],
  });
  if (!files?.length) return;
  const { jobs } = await api.importLocal(state.project.id, files);
  for (const j of jobs) state.jobs.set(j.id, j);
  renderJobs();
  toast(`Adding ${jobs.length} file${jobs.length > 1 ? "s" : ""}`);
}

// ---------------- SSE ----------------
function connectEvents(id) {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/projects/${id}/events`);
  state.es = es;
  es.addEventListener("job", async (e) => {
    const job = JSON.parse(e.data);
    const prev = state.jobs.get(job.id);
    state.jobs.set(job.id, job);
    renderJobs();
    if (job.status === "done" && prev?.status !== "done") {
      if (job.kind === "ingest") {
        await reloadProject();
        toast(`${job.label} is ready`);
      } else if (job.kind === "plan" || job.kind === "revise") {
        state.undo = [];
        await reloadProject({ resetSelection: true });
        tl.fit();
        $("zoom").value = tl.pps;
        setTab("claude");
        player.seek(0);
        toast("Claude updated the timeline");
      } else if (job.kind === "render") {
        await reloadProject();
        setTab("renders");
        toast(`${job.label} finished`);
      } else if (job.kind === "upload") {
        await reloadProject();
        toast("Uploaded to Google Drive");
      }
    } else if (job.status === "failed" && prev?.status !== "failed") {
      toast(`${job.kind} failed: ${job.error}`, true);
    }
  });
}

// ---------------- modal ----------------
function closeModal() {
  $("modalRoot").innerHTML = "";
}
function modal({ title, body, ok = "OK", okId = "", onOpen, collect }) {
  return new Promise((resolve) => {
    const root = $("modalRoot");
    root.innerHTML = `<div class="modal-bg"><div class="modal"><header><h2 class="grow" style="font-size:15px"></h2><button class="btn icon ghost" id="mClose">✕</button></header><div class="content">${body}</div><footer><button class="btn" id="mCancel">${ok ? "Cancel" : "Close"}</button>${ok ? `<button class="btn primary" id="mOk" ${okId ? `data-okid="${okId}"` : ""}>${ok}</button>` : ""}</footer></div></div>`;
    root.querySelector("h2").textContent = title;
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    root.querySelector("#mClose").onclick = () => done(null);
    root.querySelector("#mCancel").onclick = () => done(null);
    const okBtn = root.querySelector("#mOk");
    if (okBtn) {
      if (okId) okBtn.id = okId;
      okBtn.onclick = () => done(collect ? collect() : true);
    }
    root.querySelector(".modal-bg").onclick = (e) => e.target.classList.contains("modal-bg") && done(null);
    onOpen?.(root);
    root.querySelector("input, textarea")?.focus();
  });
}
const confirmModal = (text) => modal({ title: "Confirm", body: `<p>${esc(text)}</p>`, ok: "Yes" });

route();
