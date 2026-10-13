// Tiny JSON-on-disk project store with atomic writes and per-project revisions.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "./config.js";

export const newId = (prefix = "") => prefix + crypto.randomBytes(5).toString("hex");

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

export async function ensureDirs(projectId) {
  for (const fn of [paths.project, paths.media, paths.proxies, paths.thumbs, paths.renders, paths.work]) {
    await fs.mkdir(fn(projectId), { recursive: true });
  }
}

export async function listProjects() {
  await fs.mkdir(paths.projects, { recursive: true });
  const ids = await fs.readdir(paths.projects);
  const out = [];
  for (const id of ids) {
    const p = await readJson(path.join(paths.project(id), "project.json"));
    if (p) out.push({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, mediaCount: p.media.length, renders: p.renders.length });
  }
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export async function createProject(name, settings = {}) {
  const id = newId("p");
  await ensureDirs(id);
  const now = new Date().toISOString();
  const project = {
    id,
    name: name || "Untitled project",
    createdAt: now,
    updatedAt: now,
    settings: { width: 1920, height: 1080, fps: 30, ...settings },
    media: [],
    timeline: emptyTimeline(),
    revision: 1,
    history: [], // checkpoints: {revision, label, at, timeline}
    chat: [], // {role, text, at}
    renders: [], // {id, kind, file, status, createdAt, width, height, driveFileId?}
  };
  await saveProject(project);
  return project;
}

export function emptyTimeline() {
  return {
    tracks: [
      { id: "V1", kind: "video", name: "Video", clips: [] },
      { id: "T1", kind: "text", name: "Titles", clips: [] },
      { id: "A1", kind: "audio", name: "Music", clips: [] },
    ],
  };
}

export async function getProject(id) {
  if (!/^p[0-9a-f]{10}$/.test(id)) return null;
  return readJson(path.join(paths.project(id), "project.json"));
}

export async function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  await writeAtomic(path.join(paths.project(project.id), "project.json"), project);
  return project;
}

export async function deleteProject(id) {
  if (!(await getProject(id))) return false;
  await fs.rm(paths.project(id), { recursive: true, force: true });
  return true;
}

/** Replace the timeline, bumping the revision. Keeps the previous one as a checkpoint. */
export async function commitTimeline(project, timeline, label) {
  project.history.push({ revision: project.revision, label: label || "edit", at: new Date().toISOString(), timeline: project.timeline });
  if (project.history.length > 60) project.history.splice(0, project.history.length - 60);
  project.timeline = timeline;
  project.revision += 1;
  await saveProject(project);
  return project;
}

export async function loadGoogleTokens() {
  return readJson(paths.tokens, null);
}
export async function saveGoogleTokens(tokens) {
  await fs.mkdir(path.dirname(paths.tokens), { recursive: true });
  if (!tokens) {
    await fs.rm(paths.tokens, { force: true });
    return;
  }
  await writeAtomic(paths.tokens, tokens);
}
