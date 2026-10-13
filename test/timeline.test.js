import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTimeline, timelineDuration, describeTimeline } from "../server/timeline.js";

const media = [
  { id: "mA", name: "a.mp4", kind: "video", duration: 10, hasAudio: true },
  { id: "mB", name: "b.mp4", kind: "video", duration: 5, hasAudio: false },
  { id: "mImg", name: "pic.jpg", kind: "image", duration: 0, hasAudio: false },
  { id: "mMus", name: "music.mp3", kind: "audio", duration: 60, hasAudio: true },
];

test("fills defaults, ids and clamps source ranges", () => {
  const t = normalizeTimeline({ tracks: [{ id: "V1", kind: "video", clips: [{ mediaId: "mA", start: 0, duration: 20, in: 8 }] }] }, media);
  const clip = t.tracks[0].clips[0];
  assert.ok(clip.id);
  assert.equal(clip.duration, 2); // 10s source, in=8 → max 2s
  assert.equal(clip.fit, "cover");
  assert.equal(clip.transitionIn.type, "cut");
  assert.equal(t.tracks.length, 3); // text + audio tracks added
  assert.equal(timelineDuration(t), 2);
});

test("rejects overlaps unless ripple", () => {
  const tl = { tracks: [{ id: "V1", kind: "video", clips: [{ mediaId: "mA", start: 0, duration: 4 }, { mediaId: "mB", start: 2, duration: 3 }] }] };
  assert.throws(() => normalizeTimeline(tl, media), /Overlapping/);
  const rippled = normalizeTimeline(tl, media, { ripple: true });
  assert.equal(rippled.tracks[0].clips[1].start, 4);
});

test("drops a dissolve that has no touching predecessor and caps its duration", () => {
  const tl = {
    tracks: [{ id: "V1", kind: "video", clips: [{ mediaId: "mA", start: 0, duration: 1, transitionIn: { type: "dissolve", duration: 2 } }, { mediaId: "mB", start: 1, duration: 3, transitionIn: { type: "dissolve", duration: 2 } }, { mediaId: "mB", start: 6, duration: 1, transitionIn: { type: "fade", duration: 1 } }] }],
  };
  const t = normalizeTimeline(tl, media);
  const [a, b, c] = t.tracks[0].clips;
  assert.equal(a.transitionIn.type, "cut");
  assert.equal(b.transitionIn.type, "dissolve");
  assert.equal(b.transitionIn.duration, 0.5); // min(2, 1/2, 3/2)
  assert.equal(c.transitionIn.type, "cut"); // gap before it
});

test("refuses audio on video track and unknown media", () => {
  assert.throws(() => normalizeTimeline({ tracks: [{ id: "V1", kind: "video", clips: [{ mediaId: "mMus", start: 0, duration: 1 }] }] }, media), /cannot go on a video track/);
  assert.throws(() => normalizeTimeline({ tracks: [{ id: "V1", kind: "video", clips: [{ mediaId: "nope", start: 0, duration: 1 }] }] }, media), /unknown media/);
  assert.throws(() => normalizeTimeline({ tracks: [{ id: "A1", kind: "audio", clips: [{ mediaId: "mB", start: 0, duration: 1 }] }] }, media), /has no audio/);
});

test("describeTimeline is readable", () => {
  const t = normalizeTimeline({ tracks: [{ id: "V1", kind: "video", clips: [{ mediaId: "mA", start: 0, duration: 3 }] }, { id: "T1", kind: "text", clips: [{ text: "Hi", start: 0, duration: 1 }] }] }, media);
  const s = describeTimeline(t, media);
  assert.match(s, /a\.mp4/);
  assert.match(s, /"Hi"/);
  assert.match(s, /Total duration: 3.00s/);
});
