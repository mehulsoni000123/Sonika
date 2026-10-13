// In-process job queue with progress events pushed to the browser over SSE.
import { EventEmitter } from "node:events";
import { newId } from "./store.js";

const jobs = new Map();
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function createJob(kind, projectId, meta = {}) {
  const job = { id: newId("j"), kind, projectId, status: "queued", progress: 0, message: "", result: null, error: null, createdAt: Date.now(), ...meta };
  jobs.set(job.id, job);
  emit(job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs(projectId) {
  return [...jobs.values()].filter((j) => j.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

export function update(job, patch) {
  Object.assign(job, patch);
  emit(job);
}

function emit(job) {
  bus.emit("job", publicJob(job));
}

export function publicJob(job) {
  const { id, kind, projectId, status, progress, message, result, error, createdAt, label } = job;
  return { id, kind, projectId, status, progress, message, result, error, createdAt, label };
}

/** Run `fn(job, report)` in the background. `report(progress, message)` streams progress. */
export function run(job, fn) {
  update(job, { status: "running" });
  const report = (progress, message) => update(job, { progress: Math.max(0, Math.min(1, progress)), message: message ?? job.message });
  Promise.resolve()
    .then(() => fn(job, report))
    .then((result) => update(job, { status: "done", progress: 1, result: result ?? null }))
    .catch((err) => {
      console.error(`[job ${job.id} ${job.kind}] failed:`, err);
      update(job, { status: "failed", error: String(err?.message || err) });
    });
  return job;
}

export function subscribe(projectId, listener) {
  const handler = (job) => {
    if (!projectId || job.projectId === projectId) listener(job);
  };
  bus.on("job", handler);
  return () => bus.off("job", handler);
}

// Forget finished jobs after an hour so the map doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if ((job.status === "done" || job.status === "failed") && job.createdAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();
