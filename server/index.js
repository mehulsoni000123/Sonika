import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import multer from "multer";
import { config, paths } from "./config.js";
import * as store from "./store.js";
import * as jobs from "./jobs.js";
import * as media from "./media.js";
import * as drive from "./drive.js";
import { renderTimeline } from "./render.js";
import { normalizeTimeline, timelineDuration } from "./timeline.js";
import { planEdit, reviseEdit } from "./ai/planner.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));

// ---------- auth (single shared password, optional) ----------
const authToken = config.appPassword ? crypto.createHash("sha256").update(config.appPassword).digest("hex") : null;
const cookie = (req, name) => (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1];

app.post("/login", (req, res) => {
  if (!authToken) return res.redirect("/");
  if (req.body?.password === config.appPassword) {
    res.setHeader("Set-Cookie", `sonika=${authToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Wrong password" });
});

app.use((req, res, next) => {
  if (!authToken || req.path === "/login" || req.path === "/login.html" || req.path === "/styles.css" || req.path.startsWith("/auth/google")) return next();
  if (cookie(req, "sonika") === authToken) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  res.redirect("/login.html");
});

app.use(express.static(config.webDir, { extensions: ["html"] }));

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
async function loadProject(req, res) {
  const p = await store.getProject(req.params.id);
  if (!p) {
    res.status(404).json({ error: "Project not found" });
    return null;
  }
  return p;
}
const publicProject = (p) => ({ ...p, history: p.history.map(({ timeline, ...h }) => h), duration: timelineDuration(p.timeline) });

// ---------- projects ----------
app.get("/api/health", (req, res) => res.json({ ok: true, model: config.model, mockAi: config.mockAi, concurrency: config.concurrency, drive: drive.isConfigured(), anthropic: !!process.env.ANTHROPIC_API_KEY || config.mockAi }));

app.get("/api/projects", wrap(async (req, res) => res.json(await store.listProjects())));

app.post("/api/projects", wrap(async (req, res) => {
  const { name, aspect = "16:9", fps = 30 } = req.body || {};
  const sizes = { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350] };
  const [width, height] = sizes[aspect] || sizes["16:9"];
  const p = await store.createProject(name, { width, height, fps: [24, 25, 30, 50, 60].includes(Number(fps)) ? Number(fps) : 30 });
  res.status(201).json(publicProject(p));
}));

app.get("/api/projects/:id", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (p) res.json(publicProject(p));
}));

app.patch("/api/projects/:id", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  if (typeof req.body.name === "string" && req.body.name.trim()) p.name = req.body.name.trim().slice(0, 120);
  await store.saveProject(p);
  res.json(publicProject(p));
}));

app.delete("/api/projects/:id", wrap(async (req, res) => {
  res.json({ ok: await store.deleteProject(req.params.id) });
}));

// ---------- media: upload / drive import ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, paths.media(req.params.id)),
    filename: (req, file, cb) => cb(null, `${store.newId("u")}_${media.safeName(file.originalname)}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 * 1024 },
});

function ingestJob(project, localFile, originalName, source) {
  const job = jobs.createJob("ingest", project.id, { label: originalName });
  jobs.run(job, async (j, report) => {
    const m = await media.ingest(project.id, localFile, originalName, source, report);
    const fresh = await store.getProject(project.id);
    fresh.media.push(m);
    await store.saveProject(fresh);
    return { mediaId: m.id };
  });
  return job;
}

app.post("/api/projects/:id/upload", wrap(async (req, res, next) => {
  const p = await loadProject(req, res);
  if (!p) return;
  upload.array("files", 50)(req, res, (err) => {
    if (err) return next(err);
    const started = (req.files || []).map((f) => jobs.publicJob(ingestJob(p, f.path, f.originalname, { type: "upload" })));
    res.status(202).json({ jobs: started });
  });
}));

app.post("/api/projects/:id/import-drive", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const items = [...(req.body.fileIds || []), ...(req.body.links || []).map(drive.extractFileId)].filter(Boolean);
  if (!items.length) return res.status(400).json({ error: "No Drive files given" });
  const started = [];
  for (const fileId of items) {
    const job = jobs.createJob("ingest", p.id, { label: `Drive ${fileId.slice(0, 8)}…` });
    jobs.run(job, async (j, report) => {
      const meta = await drive.getMeta(fileId);
      jobs.update(j, { label: meta.name });
      report(0.01, "Downloading from Drive");
      const local = await drive.download(fileId, p.id, `${store.newId("d")}_${media.safeName(meta.name)}`, (f) => report(f * 0.4, "Downloading from Drive"));
      const m = await media.ingest(p.id, local, meta.name, { type: "drive", driveId: fileId }, (f, msg) => report(0.4 + f * 0.6, msg));
      const fresh = await store.getProject(p.id);
      fresh.media.push(m);
      await store.saveProject(fresh);
      return { mediaId: m.id };
    });
    started.push(jobs.publicJob(job));
  }
  res.status(202).json({ jobs: started });
}));

app.patch("/api/projects/:id/media/:mid", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const m = p.media.find((x) => x.id === req.params.mid);
  if (!m) return res.status(404).json({ error: "Media not found" });
  if (typeof req.body.transcript === "string") m.transcript = req.body.transcript.slice(0, 40000);
  if (typeof req.body.name === "string" && req.body.name.trim()) m.name = req.body.name.trim().slice(0, 160);
  await store.saveProject(p);
  res.json(m);
}));

app.delete("/api/projects/:id/media/:mid", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const m = p.media.find((x) => x.id === req.params.mid);
  if (!m) return res.status(404).json({ error: "Media not found" });
  const used = p.timeline.tracks.some((t) => t.clips.some((c) => c.mediaId === m.id));
  if (used && !req.query.force) return res.status(409).json({ error: "This file is used on the timeline. Remove its clips first, or pass ?force=1 to delete them too." });
  if (used) {
    for (const t of p.timeline.tracks) t.clips = t.clips.filter((c) => c.mediaId !== m.id);
    p.timeline = normalizeTimeline(p.timeline, p.media.filter((x) => x.id !== m.id), { ripple: true });
  }
  p.media = p.media.filter((x) => x.id !== m.id);
  await media.removeMediaFiles(p.id, m);
  await store.saveProject(p);
  res.json(publicProject(p));
}));

// Files (proxies, thumbs, renders, originals) — sendFile handles Range requests for video seeking.
app.get("/files/:id/:kind/:file", wrap(async (req, res) => {
  if (!["media", "proxies", "thumbs", "renders"].includes(req.params.kind)) return res.status(404).end();
  const p = await store.getProject(req.params.id);
  if (!p) return res.status(404).end();
  const dir = paths[req.params.kind](p.id);
  const file = path.basename(req.params.file);
  res.sendFile(file, { root: dir, maxAge: req.params.kind === "renders" ? 0 : "7d", dotfiles: "deny" }, (err) => err && res.status(err.statusCode || 404).end());
}));

// ---------- timeline ----------
app.put("/api/projects/:id/timeline", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const { timeline, revision, label } = req.body || {};
  if (Number(revision) !== p.revision) return res.status(409).json({ error: "Timeline changed elsewhere; reload.", project: publicProject(p) });
  let normalized;
  try {
    normalized = normalizeTimeline(timeline, p.media);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  await store.commitTimeline(p, normalized, label || "edit");
  res.json(publicProject(p));
}));

app.get("/api/projects/:id/history", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (p) res.json(p.history.map(({ timeline, ...h }) => h));
}));

app.post("/api/projects/:id/history/restore", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const entry = p.history.find((h) => h.revision === Number(req.body.revision));
  if (!entry) return res.status(404).json({ error: "Checkpoint not found" });
  const normalized = normalizeTimeline(entry.timeline, p.media, { ripple: true });
  await store.commitTimeline(p, normalized, `restore r${entry.revision}`);
  res.json(publicProject(p));
}));

// ---------- AI ----------
function aiJob(project, kind, text, fn) {
  const job = jobs.createJob(kind, project.id, { label: text.slice(0, 80) });
  jobs.run(job, async (j, report) => {
    const fresh = await store.getProject(project.id);
    fresh.chat.push({ role: "user", text, at: new Date().toISOString() });
    await store.saveProject(fresh);
    const { timeline, summary } = await fn(fresh, report);
    const latest = await store.getProject(project.id);
    latest.chat = fresh.chat;
    latest.chat.push({ role: "claude", text: summary, at: new Date().toISOString() });
    await store.commitTimeline(latest, timeline, kind === "plan" ? "Claude: first cut" : `Claude: ${text.slice(0, 40)}`);
    return { revision: latest.revision, summary };
  });
  return job;
}

app.post("/api/projects/:id/ai/plan", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const brief = String(req.body.brief || "").slice(0, 8000);
  res.status(202).json({ job: jobs.publicJob(aiJob(p, "plan", brief || "Make the best tight cut of this footage.", (fresh, report) => planEdit(fresh, brief, report))) });
}));

app.post("/api/projects/:id/ai/revise", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const instruction = String(req.body.instruction || "").trim().slice(0, 8000);
  if (!instruction) return res.status(400).json({ error: "Tell Claude what to change" });
  res.status(202).json({ job: jobs.publicJob(aiJob(p, "revise", instruction, (fresh, report) => reviseEdit(fresh, instruction, report))) });
}));

// ---------- render ----------
app.post("/api/projects/:id/render", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const quality = req.body.quality === "final" ? "final" : "preview";
  if (!timelineDuration(p.timeline)) return res.status(400).json({ error: "The timeline is empty" });
  const renderId = store.newId("r");
  const job = jobs.createJob("render", p.id, { label: `${quality} render`, renderId });
  jobs.run(job, async (j, report) => {
    const result = await renderTimeline(p, { quality, renderId, report });
    const fresh = await store.getProject(p.id);
    const entry = { id: renderId, quality, revision: p.revision, createdAt: new Date().toISOString(), ...result };
    fresh.renders.unshift(entry);
    await store.saveProject(fresh);
    return entry;
  });
  res.status(202).json({ job: jobs.publicJob(job) });
}));

app.delete("/api/projects/:id/renders/:rid", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const r = p.renders.find((x) => x.id === req.params.rid);
  if (!r) return res.status(404).json({ error: "Render not found" });
  await fs.rm(path.join(paths.renders(p.id), r.file), { force: true });
  p.renders = p.renders.filter((x) => x.id !== r.id);
  await store.saveProject(p);
  res.json(publicProject(p));
}));

app.post("/api/projects/:id/renders/:rid/drive", wrap(async (req, res) => {
  const p = await loadProject(req, res);
  if (!p) return;
  const r = p.renders.find((x) => x.id === req.params.rid);
  if (!r) return res.status(404).json({ error: "Render not found" });
  const job = jobs.createJob("upload", p.id, { label: `Upload ${r.quality} to Drive` });
  jobs.run(job, async (j, report) => {
    report(0.1, "Uploading to Google Drive");
    const name = `${p.name.replace(/[\\/:*?"<>|]+/g, "-")} - ${r.quality} r${r.revision}.mp4`;
    const out = await drive.upload(path.join(paths.renders(p.id), r.file), name, req.body.folderId);
    const fresh = await store.getProject(p.id);
    const entry = fresh.renders.find((x) => x.id === r.id);
    if (entry) Object.assign(entry, { driveFileId: out.id, driveLink: out.link });
    await store.saveProject(fresh);
    return out;
  });
  res.status(202).json({ job: jobs.publicJob(job) });
}));

// ---------- jobs / events ----------
app.get("/api/projects/:id/jobs", (req, res) => res.json(jobs.listJobs(req.params.id).map(jobs.publicJob)));

app.get("/api/projects/:id/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`event: hello\ndata: {}\n\n`);
  const unsub = jobs.subscribe(req.params.id, (job) => res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`));
  const ping = setInterval(() => res.write(`: ping\n\n`), 20000);
  req.on("close", () => {
    clearInterval(ping);
    unsub();
  });
});

// ---------- Google Drive ----------
app.get("/api/drive/status", wrap(async (req, res) => res.json(await drive.status())));
app.get("/auth/google", (req, res) => {
  if (!drive.isConfigured()) return res.status(400).send("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.");
  res.redirect(drive.authUrl());
});
app.get("/auth/google/callback", wrap(async (req, res) => {
  if (!req.query.code) return res.status(400).send("Missing code");
  await drive.handleCallback(String(req.query.code));
  res.redirect("/?drive=connected");
}));
app.post("/api/drive/disconnect", wrap(async (req, res) => {
  await drive.disconnect();
  res.json({ ok: true });
}));
app.get("/api/drive/list", wrap(async (req, res) => {
  res.json(await drive.list({ parent: req.query.parent || "root", q: req.query.q || "", pageToken: req.query.pageToken }));
}));

// ---------- errors ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

await fs.mkdir(paths.projects, { recursive: true });
app.listen(config.port, () => {
  console.log(`Sonika listening on http://localhost:${config.port}  (model ${config.model}${config.mockAi ? ", MOCK_AI" : ""}, ${config.concurrency} render lanes, Drive ${drive.isConfigured() ? "configured" : "not configured"})`);
});
