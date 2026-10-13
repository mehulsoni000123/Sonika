import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { DATA_DIR, makeVideo, makeImage, makeAudio } from "./helpers.js";

const { paths } = await import("../server/config.js");
const store = await import("../server/store.js");
const media = await import("../server/media.js");
const { ffprobe } = await import("../server/ffmpeg.js");
const { renderTimeline, planSegments } = await import("../server/render.js");
const { normalizeTimeline, timelineDuration } = await import("../server/timeline.js");
const { planEdit } = await import("../server/ai/planner.js");

const project = await store.createProject("Render test", { width: 640, height: 360, fps: 25 });

test("ingest analyses video, image and audio", async () => {
  const v1 = await makeVideo(project.id, "clip1.mp4", 6);
  const v2 = await makeVideo(project.id, "clip2.mp4", 4, { audio: false });
  const img = await makeImage(project.id, "pic.jpg");
  const mus = await makeAudio(project.id, "music.mp3", 20);
  const [m1, m2, m3, m4] = await Promise.all([
    media.ingest(project.id, v1, "clip1.mp4", { type: "upload" }),
    media.ingest(project.id, v2, "clip2.mp4", { type: "upload" }),
    media.ingest(project.id, img, "pic.jpg", { type: "upload" }),
    media.ingest(project.id, mus, "music.mp3", { type: "upload" }),
  ]);
  assert.equal(m1.kind, "video");
  assert.ok(Math.abs(m1.duration - 6) < 0.2);
  assert.equal(m1.hasAudio, true);
  assert.equal(m2.hasAudio, false);
  assert.equal(m3.kind, "image");
  assert.equal(m4.kind, "audio");
  for (const f of [m1.proxy, m2.proxy]) await fs.access(path.join(paths.proxies(project.id), f));
  for (const f of [m1.poster, m1.strip, m1.contact, m3.poster]) await fs.access(path.join(paths.thumbs(project.id), f));
  assert.ok(m1.stripFrames >= 1);
  project.media.push(m1, m2, m3, m4);
  await store.saveProject(project);
});

test("mock planner produces a valid timeline", async () => {
  const { timeline, summary } = await planEdit(project, "test brief");
  assert.ok(summary);
  assert.equal(timeline.tracks[0].clips.length, 3);
  assert.ok(timelineDuration(timeline) > 0);
});

test("renders a timeline with dissolve, fade, speed, image, text and music", async () => {
  const [m1, m2, m3, m4] = project.media;
  const timeline = normalizeTimeline(
    {
      tracks: [
        {
          id: "V1",
          kind: "video",
          clips: [
            { mediaId: m1.id, start: 0, duration: 2, in: 1 },
            { mediaId: m2.id, start: 2, duration: 2, in: 0, transitionIn: { type: "dissolve", duration: 0.5 } },
            { mediaId: m1.id, start: 4, duration: 1, in: 4, speed: 2, transitionIn: { type: "fade", duration: 0.4 } },
            { mediaId: m3.id, start: 5.5, duration: 2, kenBurns: true }, // gap of 0.5s → black
          ],
        },
        { id: "T1", kind: "text", clips: [{ text: "Hello\nworld: 100% 'ok'", start: 0.5, duration: 3, preset: "hook", position: "center" }, { text: "Lower third", start: 4, duration: 2, preset: "lower-third", position: "bottom" }] },
        { id: "A1", kind: "audio", clips: [{ mediaId: m4.id, start: 0, duration: 7.5, in: 2, volume: 0.3 }] },
      ],
    },
    project.media,
  );
  project.timeline = timeline;
  const segs = planSegments(timeline);
  assert.deepEqual(segs.map((s) => s.kind), ["clip", "clip", "clip", "black", "clip"]);
  assert.equal(segs[0].extendTail, 0.5);
  assert.equal(segs[1].fadeOutExtra, 0.4);

  const progress = [];
  const result = await renderTimeline(project, { quality: "preview", renderId: "rtest1", report: (p, m) => progress.push([p, m]) });
  const out = path.join(paths.renders(project.id), result.file);
  const info = await ffprobe(out);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  assert.ok(v && a, "video + audio streams");
  assert.equal(v.width, 640);
  assert.equal(v.height, 360);
  assert.ok(Math.abs(Number(info.format.duration) - 7.5) < 0.25, `duration ${info.format.duration}`);
  assert.ok(progress.some(([p]) => p > 0.5));
});

test("final quality render without dissolves uses stream copy and lands", async () => {
  const [m1, m2] = project.media;
  project.timeline = normalizeTimeline({ tracks: [{ id: "V1", kind: "video", clips: [{ mediaId: m1.id, start: 0, duration: 1.5 }, { mediaId: m2.id, start: 1.5, duration: 1.5 }] }] }, project.media);
  const result = await renderTimeline(project, { quality: "final", renderId: "rtest2" });
  const info = await ffprobe(path.join(paths.renders(project.id), result.file));
  assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.2);
});

test.after(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});
