// Timeline model: schema, validation, normalization, and helpers shared by the
// API, the renderer and the AI planner.
import { z } from "zod";

export const TEXT_PRESETS = ["hook", "title", "subtitle", "lower-third", "caption", "callout"];
export const POSITIONS = ["top", "center", "bottom"];
export const TRANSITIONS = ["cut", "fade", "dissolve"];

const num = (min = 0) => z.number().finite().min(min);

const VideoClip = z.object({
  id: z.string().optional(),
  mediaId: z.string(),
  start: num(),
  duration: z.number().finite().positive(),
  in: num().default(0),
  speed: z.number().finite().min(0.25).max(4).default(1),
  volume: z.number().finite().min(0).max(3).default(1),
  muted: z.boolean().default(false),
  fit: z.enum(["cover", "contain"]).default("cover"),
  kenBurns: z.boolean().default(false),
  transitionIn: z.object({ type: z.enum(TRANSITIONS).default("cut"), duration: z.number().finite().min(0.1).max(3).default(0.5) }).default({ type: "cut", duration: 0.5 }),
  fadeOut: z.number().finite().min(0).max(5).default(0),
  label: z.string().max(120).default(""),
});

const TextClip = z.object({
  id: z.string().optional(),
  text: z.string().min(1).max(400),
  start: num(),
  duration: z.number().finite().positive(),
  preset: z.enum(TEXT_PRESETS).default("title"),
  position: z.enum(POSITIONS).default("bottom"),
  align: z.enum(["left", "center"]).default("center"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
  box: z.boolean().default(true),
  boxColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#000000"),
  animation: z.enum(["none", "fade", "pop"]).default("fade"),
});

const AudioClip = z.object({
  id: z.string().optional(),
  mediaId: z.string(),
  start: num(),
  duration: z.number().finite().positive(),
  in: num().default(0),
  volume: z.number().finite().min(0).max(3).default(0.2),
  fadeIn: z.number().finite().min(0).max(10).default(1),
  fadeOut: z.number().finite().min(0).max(10).default(2),
});

export const TrackSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("video"), name: z.string().default("Video"), clips: z.array(VideoClip) }),
  z.object({ id: z.string(), kind: z.literal("text"), name: z.string().default("Titles"), clips: z.array(TextClip) }),
  z.object({ id: z.string(), kind: z.literal("audio"), name: z.string().default("Music"), clips: z.array(AudioClip) }),
]);

export const TimelineSchema = z.object({ tracks: z.array(TrackSchema).min(1) });

let counter = 0;
export const clipId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * Validate + normalize a timeline against the project's media.
 * - fills ids, clamps source ranges to media duration
 * - sorts clips by start
 * - `ripple: true` pushes overlapping clips later instead of rejecting (used for AI output)
 * Throws an Error with a readable message when invalid.
 */
export function normalizeTimeline(input, media, { ripple = false } = {}) {
  const parsed = TimelineSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid timeline: ${issue.path.join(".")} ${issue.message}`);
  }
  const byId = new Map(media.map((m) => [m.id, m]));
  const timeline = parsed.data;
  const kinds = new Set();
  for (const track of timeline.tracks) {
    kinds.add(track.kind);
    for (const clip of track.clips) {
      clip.id = clip.id || clipId();
      if (track.kind !== "text") {
        const m = byId.get(clip.mediaId);
        if (!m) throw new Error(`Clip ${clip.id} references unknown media ${clip.mediaId}`);
        if (track.kind === "video" && m.kind === "audio") throw new Error(`Clip ${clip.id}: audio file ${m.name} cannot go on a video track`);
        if (track.kind === "audio" && !m.hasAudio && m.kind !== "audio") throw new Error(`Clip ${clip.id}: ${m.name} has no audio`);
        if (m.kind !== "image" && m.duration > 0) {
          clip.in = Math.min(clip.in, Math.max(0, m.duration - 0.1));
          const speed = track.kind === "video" ? clip.speed : 1;
          const maxDur = (m.duration - clip.in) / speed;
          if (clip.duration > maxDur + 0.01) clip.duration = Math.max(0.1, maxDur);
        }
        if (track.kind === "video" && m.kind === "image") clip.fit = clip.fit || "cover";
      }
      clip.start = round3(clip.start);
      clip.duration = round3(clip.duration);
    }
    track.clips.sort((a, b) => a.start - b.start || a.duration - b.duration);
    // Overlap handling
    let cursor = 0;
    for (const clip of track.clips) {
      if (clip.start < cursor - 0.001) {
        if (ripple || track.kind !== "text") {
          if (ripple) clip.start = round3(cursor);
          else throw new Error(`Overlapping clips on track ${track.id} at ${clip.start.toFixed(2)}s`);
        }
      }
      cursor = Math.max(cursor, clip.start + clip.duration);
    }
    if (track.kind === "video") {
      // A dissolve needs a preceding clip that touches this one.
      track.clips.forEach((clip, i) => {
        const prev = track.clips[i - 1];
        if (clip.transitionIn.type !== "cut" && (!prev || Math.abs(prev.start + prev.duration - clip.start) > 0.02)) {
          clip.transitionIn = { type: "cut", duration: 0.5 };
        }
        if (prev && clip.transitionIn.type === "dissolve") {
          clip.transitionIn.duration = Math.min(clip.transitionIn.duration, prev.duration / 2, clip.duration / 2);
        }
      });
    }
  }
  if (!kinds.has("video")) timeline.tracks.unshift({ id: "V1", kind: "video", name: "Video", clips: [] });
  if (!kinds.has("text")) timeline.tracks.push({ id: "T1", kind: "text", name: "Titles", clips: [] });
  if (!kinds.has("audio")) timeline.tracks.push({ id: "A1", kind: "audio", name: "Music", clips: [] });
  return timeline;
}

export const round3 = (n) => Math.round(n * 1000) / 1000;

export function timelineDuration(timeline) {
  let end = 0;
  for (const t of timeline.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  return round3(end);
}

export function videoTrack(timeline) {
  return timeline.tracks.find((t) => t.kind === "video");
}

/** Compact human-readable description of a timeline, used in prompts and chat. */
export function describeTimeline(timeline, media) {
  const byId = new Map(media.map((m) => [m.id, m]));
  const lines = [];
  for (const t of timeline.tracks) {
    lines.push(`Track ${t.id} (${t.kind})`);
    for (const c of t.clips) {
      const end = (c.start + c.duration).toFixed(2);
      if (t.kind === "text") lines.push(`  ${c.id} ${c.start.toFixed(2)}-${end}s [${c.preset}/${c.position}] "${c.text}"`);
      else {
        const m = byId.get(c.mediaId);
        const tr = t.kind === "video" && c.transitionIn?.type !== "cut" ? ` ${c.transitionIn.type}-in ${c.transitionIn.duration}s` : "";
        lines.push(`  ${c.id} ${c.start.toFixed(2)}-${end}s ← ${m?.name || c.mediaId} @ ${c.in.toFixed(2)}s${c.speed && c.speed !== 1 ? ` x${c.speed}` : ""}${tr}${c.label ? ` (${c.label})` : ""}`);
      }
    }
  }
  lines.push(`Total duration: ${timelineDuration(timeline).toFixed(2)}s`);
  return lines.join("\n");
}
