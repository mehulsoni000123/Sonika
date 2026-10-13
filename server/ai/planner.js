// Claude as the editor: turns a brief + analyzed media into a timeline, and
// revises an existing timeline from chat instructions. Uses structured
// outputs so the result always validates.
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config, paths } from "../config.js";
import { PlanSchema } from "./schema.js";
import { normalizeTimeline, describeTimeline, clipId, round3 } from "../timeline.js";

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM = `You are Sonika's editor: a senior short-form and documentary video editor who cuts with intent.

You receive a brief, a media bin with analysis (durations, detected scene changes, speech/silence ranges, transcripts when available) and a contact sheet of frames with burned-in timecodes for every video. You plan the edit as a timeline.

How you cut:
- Open on the strongest moment. For social and promo work, the first 2-3 seconds must create curiosity (a hook: a bold frame, a question, a result shown early).
- Cut on speech: keep source ranges that fall inside speech segments so you never slice a sentence. Trim dead air using the silence ranges. Leave about 0.15s of breath before and after a spoken phrase.
- Respect scene changes: do not start a clip 0.3s before a detected scene cut.
- Use the contact sheet timecodes to pick shots. Prefer clear, well-lit, stable frames. Vary shot sizes.
- Keep clips purposeful. Talking-head sections 3-12s each; b-roll 1.5-4s. Match the target duration from the brief; if none, make it tight.
- Text: short and readable. A hook at the start, lower thirds for names, captions or callouts for key numbers. Never cover the whole frame with text. At most one text element on screen at a time.
- Transitions: cuts by default; a dissolve or fade only for a change of time or place. Never more than one in ten cuts.
- Music under dialogue at 0.12-0.25; a mute b-roll clip over dialogue must come from a different file than the dialogue clip or the lips will not match.
- Every clip's in + duration*speed must fit inside the source duration. Images have no duration: give them 2-5s.
- When revising, change only what the instruction asks for and keep everything else exactly as it is, including ids of timing of untouched clips.

Write the summary for a professional editor: what the cut does and why, in plain language, no fluff.`;

function mediaBrief(m) {
  const parts = [`- ${m.id} "${m.name}" ${m.kind}`];
  if (m.kind !== "image") parts.push(`${m.duration.toFixed(2)}s`);
  if (m.width) parts.push(`${m.width}x${m.height}`);
  if (m.kind === "video") parts.push(m.hasAudio ? "with audio" : "no audio");
  const line = [parts.join(" ")];
  if (m.scenes?.length) line.push(`  scene changes at: ${m.scenes.slice(0, 60).map((t) => t.toFixed(1)).join(", ")}${m.scenes.length > 60 ? " …" : ""}`);
  if (m.speech?.length) line.push(`  speech ranges: ${m.speech.slice(0, 80).map(([a, b]) => `${a}-${b}`).join(", ")}${m.speech.length > 80 ? " …" : ""}`);
  if (m.transcript) line.push(`  transcript: ${m.transcript.slice(0, 6000)}`);
  return line.join("\n");
}

async function contactBlocks(project) {
  const blocks = [];
  for (const m of project.media) {
    if (!m.contact) continue;
    try {
      const data = await fs.readFile(path.join(paths.thumbs(project.id), m.contact));
      blocks.push({ type: "text", text: `Contact sheet for ${m.id} "${m.name}" (timecodes burned in):` });
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") } });
    } catch {
      /* no sheet */
    }
  }
  return blocks;
}

function projectContext(project) {
  const s = project.settings;
  return [
    `Project: ${project.name}`,
    `Output: ${s.width}x${s.height} @ ${s.fps}fps (${s.width > s.height ? "landscape" : s.width < s.height ? "vertical" : "square"})`,
    `Media bin:`,
    ...project.media.map(mediaBrief),
  ].join("\n");
}

/** Convert Claude's plan to the internal timeline (then normalized by the caller). */
export function planToTimeline(plan, existing) {
  const video = [];
  let cursor = 0;
  for (const c of plan.video) {
    const dur = round3(Math.max(0.2, c.duration));
    video.push({
      id: clipId(),
      mediaId: c.mediaId,
      start: round3(cursor),
      duration: dur,
      in: Math.max(0, c.in || 0),
      speed: c.speed > 0 ? c.speed : 1,
      volume: 1,
      muted: !!c.muted,
      fit: "cover",
      kenBurns: !!c.kenBurns,
      transitionIn: { type: c.transitionIn || "cut", duration: Math.min(3, Math.max(0.1, c.transitionDuration || 0.5)) },
      fadeOut: 0,
      label: (c.label || "").slice(0, 120),
    });
    cursor += dur;
  }
  const text = plan.text.map((t) => ({ id: clipId(), text: t.text, start: Math.max(0, t.start), duration: Math.max(0.3, t.duration), preset: t.preset, position: t.position, align: t.preset === "lower-third" ? "left" : "center", color: "#FFFFFF", box: true, boxColor: "#000000", animation: "fade" }));
  const music = plan.music.map((a) => ({ id: clipId(), mediaId: a.mediaId, start: Math.max(0, a.start), duration: Math.max(0.5, a.duration), in: Math.max(0, a.in || 0), volume: Math.min(3, Math.max(0, a.volume ?? 0.2)), fadeIn: 1, fadeOut: 2 }));
  const tracks = existing?.tracks?.length ? existing.tracks : null;
  return {
    tracks: [
      { id: tracks?.find((t) => t.kind === "video")?.id || "V1", kind: "video", name: "Video", clips: video },
      { id: tracks?.find((t) => t.kind === "text")?.id || "T1", kind: "text", name: "Titles", clips: text },
      { id: tracks?.find((t) => t.kind === "audio")?.id || "A1", kind: "audio", name: "Music", clips: music },
    ],
  };
}

async function askClaude(project, userBlocks, report) {
  if (config.mockAi) return mockPlan(project);
  report(0.1, "Claude is watching the footage");
  const stream = getClient().beta.messages.stream({
    model: config.model,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(PlanSchema) },
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userBlocks }],
  });
  let chars = 0;
  stream.on("text", (t) => {
    chars += t.length;
    report(Math.min(0.9, 0.3 + chars / 20000), "Claude is building the cut");
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error(`Claude declined this request${msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : ""}`);
  if (msg.stop_reason === "max_tokens") throw new Error("Claude's plan was cut off (max_tokens). Try a shorter brief or fewer files.");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let plan;
  try {
    plan = PlanSchema.parse(JSON.parse(text));
  } catch (err) {
    throw new Error(`Claude returned an unreadable plan: ${err.message}`);
  }
  return plan;
}

/** First cut from a brief. */
export async function planEdit(project, brief, report = () => {}) {
  if (!project.media.some((m) => m.kind !== "audio")) throw new Error("Add at least one video or image before asking for a cut.");
  const blocks = [
    { type: "text", text: `${projectContext(project)}\n\nBrief from the editor:\n${brief || "Make the best tight cut of this footage."}\n\nPlan the full edit.` },
    ...(await contactBlocks(project)),
  ];
  const plan = await askClaude(project, blocks, report);
  const timeline = normalizeTimeline(planToTimeline(plan, project.timeline), project.media, { ripple: true });
  return { timeline, summary: plan.summary };
}

/** Revise the current timeline from a chat instruction. */
export async function reviseEdit(project, instruction, report = () => {}) {
  const blocks = [
    {
      type: "text",
      text: `${projectContext(project)}\n\nCurrent timeline:\n${describeTimeline(project.timeline, project.media)}\n\nThe editor asks:\n${instruction}\n\nReturn the complete revised timeline (all clips, not just the changed ones).`,
    },
    ...(await contactBlocks(project)),
  ];
  const plan = await askClaude(project, blocks, report);
  const timeline = normalizeTimeline(planToTimeline(plan, project.timeline), project.media, { ripple: true });
  return { timeline, summary: plan.summary };
}

/** Deterministic plan used when MOCK_AI=1 (tests / running without a key). */
function mockPlan(project) {
  const visuals = project.media.filter((m) => m.kind !== "audio");
  const audio = project.media.find((m) => m.kind === "audio");
  const video = [];
  let t = 0;
  for (const m of visuals) {
    const dur = m.kind === "image" ? 3 : Math.min(6, m.duration);
    video.push({ mediaId: m.id, in: 0, duration: dur, speed: 1, transitionIn: video.length ? "dissolve" : "cut", transitionDuration: 0.5, muted: false, kenBurns: m.kind === "image", label: `mock cut of ${m.name}` });
    t += dur;
  }
  return {
    summary: "Mock plan: each visual in order, dissolves between them, a hook title up front.",
    video,
    text: [{ text: "Sonika\nmock cut", start: 0.3, duration: 2.5, preset: "hook", position: "center" }],
    music: audio ? [{ mediaId: audio.id, start: 0, duration: Math.min(t, audio.duration), in: 0, volume: 0.2 }] : [],
  };
}
