// Timeline → MP4. Segments render in parallel (one ffmpeg per clip, text
// overlays burned in), then a single fast assembly pass joins them and mixes
// music. Previews use the 540p proxies; finals use the originals.
import path from "node:path";
import fs from "node:fs/promises";
import { config, paths } from "./config.js";
import { ffmpeg, escapeFilterPath, pool } from "./ffmpeg.js";
import { timelineDuration, videoTrack, round3 } from "./timeline.js";

const PRESET_STYLE = {
  hook: { size: 0.08, position: "center", box: true },
  title: { size: 0.065, position: "center", box: false },
  subtitle: { size: 0.04, position: "center", box: false },
  "lower-third": { size: 0.038, position: "bottom", box: true, align: "left" },
  caption: { size: 0.045, position: "bottom", box: true },
  callout: { size: 0.05, position: "top", box: true },
};

function hexToFf(hex, alpha = 1) {
  return `0x${hex.replace("#", "")}@${alpha}`;
}

/** Builds the list of base-track segments (clips + black gaps) covering the whole timeline. */
export function planSegments(timeline) {
  const total = timelineDuration(timeline);
  const clips = videoTrack(timeline)?.clips || [];
  const segments = [];
  let cursor = 0;
  for (const clip of clips) {
    if (clip.start - cursor > 0.02) segments.push({ kind: "black", start: cursor, duration: round3(clip.start - cursor), clip: null });
    segments.push({ kind: "clip", start: clip.start, duration: clip.duration, clip });
    cursor = clip.start + clip.duration;
  }
  if (total - cursor > 0.02) segments.push({ kind: "black", start: cursor, duration: round3(total - cursor), clip: null });
  if (!segments.length) segments.push({ kind: "black", start: 0, duration: Math.max(1, total), clip: null });
  // Dissolves: the previous segment is rendered longer by the dissolve
  // duration so the overlap doesn't shorten the timeline.
  segments.forEach((seg, i) => {
    const next = segments[i + 1];
    const t = next?.clip?.transitionIn;
    seg.extendTail = next?.kind === "clip" && t?.type === "dissolve" ? t.duration : 0;
    seg.fadeOutExtra = next?.kind === "clip" && t?.type === "fade" ? t.duration : 0;
    seg.index = i;
    seg.total = round3(seg.duration + seg.extendTail);
  });
  return segments;
}

function textFilters(timeline, seg, W, H, workDir, textFiles) {
  const textTrack = timeline.tracks.find((t) => t.kind === "text");
  if (!textTrack) return [];
  const segEnd = seg.start + seg.total;
  const filters = [];
  for (const tc of textTrack.clips) {
    const tEnd = tc.start + tc.duration;
    if (tEnd <= seg.start || tc.start >= segEnd) continue;
    const s = round3(Math.max(0, tc.start - seg.start));
    const e = round3(Math.min(seg.total, tEnd - seg.start));
    const style = PRESET_STYLE[tc.preset] || PRESET_STYLE.title;
    const fontsize = Math.round(H * style.size);
    const position = tc.position || style.position;
    const align = tc.align || style.align || "center";
    const x = align === "left" ? `w*0.06` : `(w-text_w)/2`;
    const y = position === "top" ? `h*0.08` : position === "center" ? `(h-text_h)/2` : `h-text_h-h*0.12`;
    const file = path.join(workDir, `text_${tc.id}.txt`);
    textFiles.push({ file, text: tc.text });
    const parts = [
      `fontfile='${escapeFilterPath(config.fontFile)}'`,
      `textfile='${escapeFilterPath(file)}'`,
      `fontsize=${fontsize}`,
      `fontcolor=${hexToFf(tc.color)}`,
      `x=${x}`,
      `y=${y}`,
      `line_spacing=${Math.round(fontsize * 0.2)}`,
      `enable='between(t,${s},${e})'`,
    ];
    if (tc.box) parts.push(`box=1`, `boxcolor=${hexToFf(tc.boxColor, 0.55)}`, `boxborderw=${Math.round(fontsize * 0.45)}`);
    else parts.push(`shadowcolor=black@0.6`, `shadowx=${Math.max(1, Math.round(fontsize * 0.04))}`, `shadowy=${Math.max(1, Math.round(fontsize * 0.04))}`);
    const fade = tc.animation === "fade" ? 0.3 : tc.animation === "pop" ? 0.12 : 0;
    if (fade > 0 && e - s > fade * 2) {
      parts.push(`alpha='if(lt(t,${s}+${fade}),(t-${s})/${fade},if(gt(t,${e}-${fade}),(${e}-t)/${fade},1))'`);
    }
    filters.push(`drawtext=${parts.join(":")}`);
  }
  return filters;
}

function atempoChain(speed) {
  // atempo accepts 0.5..100 per instance; chain for slow-motion below 0.5.
  const parts = [];
  let s = speed;
  while (s < 0.5) {
    parts.push("atempo=0.5");
    s /= 0.5;
  }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

function fitFilter(fit, W, H) {
  return fit === "contain"
    ? `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`
    : `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H}`;
}

function videoCodecArgs(quality) {
  const enc = config.videoEncoder;
  if (enc === "h264_nvenc") return ["-c:v", "h264_nvenc", "-preset", quality === "final" ? "p5" : "p1", "-cq", quality === "final" ? "19" : "28", "-b:v", "0"];
  return ["-c:v", "libx264", "-preset", quality === "final" ? "medium" : "ultrafast", "-crf", quality === "final" ? "18" : "26", "-tune", quality === "final" ? "film" : "fastdecode"];
}

function mediaPath(projectId, m, quality) {
  if (m.kind === "image" || quality === "final" || !m.proxy) return path.join(paths.media(projectId), m.file);
  return path.join(paths.proxies(projectId), m.proxy);
}

/** Build the ffmpeg args for one segment. Exported for tests. */
export function segmentArgs({ seg, timeline, media, projectId, quality, W, H, FPS, workDir, outFile, textFiles }) {
  const byId = new Map(media.map((m) => [m.id, m]));
  const args = [];
  const vf = [];
  let af = [];
  let audioIn = null; // input index of the audio source
  const total = seg.total;

  if (seg.kind === "black") {
    args.push("-f", "lavfi", "-t", String(total), "-i", `color=c=black:s=${W}x${H}:r=${FPS}`);
    args.push("-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=48000:cl=stereo");
    audioIn = 1;
    vf.push("format=yuv420p");
  } else {
    const clip = seg.clip;
    const m = byId.get(clip.mediaId);
    const src = mediaPath(projectId, m, quality);
    if (m.kind === "image") {
      const frames = Math.ceil(total * FPS);
      if (clip.kenBurns) {
        args.push("-i", src);
        vf.push(`scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2}`);
        vf.push(`zoompan=z='min(zoom+0.0012,1.25)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`);
      } else {
        args.push("-loop", "1", "-framerate", String(FPS), "-t", String(total), "-i", src);
        vf.push(fitFilter(clip.fit, W, H));
      }
      args.push("-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=48000:cl=stereo");
      audioIn = 1;
    } else {
      const speed = clip.speed || 1;
      const srcSpan = round3(total * speed + 0.2);
      args.push("-ss", String(clip.in), "-t", String(srcSpan), "-i", src);
      if (speed !== 1) vf.push(`setpts=PTS/${speed}`);
      vf.push(fitFilter(clip.fit, W, H));
      const useAudio = m.hasAudio && !clip.muted && clip.volume > 0;
      if (useAudio) {
        audioIn = 0;
        if (speed !== 1) af.push(atempoChain(speed));
        if (clip.volume !== 1) af.push(`volume=${clip.volume}`);
      } else {
        args.push("-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=48000:cl=stereo");
        audioIn = 1;
      }
    }
    vf.push("setsar=1", `fps=${FPS}`, "format=yuv420p");
    if (seg.extendTail > 0) vf.push(`tpad=stop_mode=clone:stop_duration=${seg.extendTail}`);
    vf.push(`trim=duration=${total}`, "setpts=PTS-STARTPTS");
    // Fades (through black)
    const fadeIn = clip.transitionIn?.type === "fade" ? clip.transitionIn.duration : 0;
    const fadeOut = Math.max(clip.fadeOut || 0, seg.fadeOutExtra || 0);
    if (fadeIn > 0) {
      vf.push(`fade=t=in:st=0:d=${fadeIn}`);
      af.push(`afade=t=in:st=0:d=${fadeIn}`);
    }
    if (fadeOut > 0) {
      vf.push(`fade=t=out:st=${round3(Math.max(0, seg.duration - fadeOut))}:d=${fadeOut}`);
      af.push(`afade=t=out:st=${round3(Math.max(0, seg.duration - fadeOut))}:d=${fadeOut}`);
    }
  }

  vf.push(...textFilters(timeline, seg, W, H, workDir, textFiles));
  af = [...af, "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo", "apad", `atrim=duration=${total}`, "asetpts=PTS-STARTPTS"];

  const filterComplex = `[0:v]${vf.join(",")}[v];[${audioIn}:a]${af.join(",")}[a]`;
  args.push("-filter_complex", filterComplex, "-map", "[v]", "-map", "[a]");
  args.push(...videoCodecArgs(quality), "-g", String(FPS * 2), "-pix_fmt", "yuv420p");
  args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  args.push("-video_track_timescale", "90000", "-movflags", "+faststart", outFile);
  return args;
}

/** Final assembly: join segments (xfade where dissolves exist) and mix music. Exported for tests. */
export function assemblyArgs({ segments, segFiles, timeline, media, projectId, quality, listFile, outFile, W, H, FPS }) {
  const byId = new Map(media.map((m) => [m.id, m]));
  const hasDissolve = segments.some((s) => s.clip?.transitionIn?.type === "dissolve");
  const audioTrack = timeline.tracks.find((t) => t.kind === "audio");
  const music = audioTrack?.clips || [];
  const args = [];
  const fc = [];
  let inputCount = 0;
  let vLabel, aLabel;

  if (!hasDissolve) {
    args.push("-f", "concat", "-safe", "0", "-i", listFile);
    inputCount = 1;
    vLabel = "0:v";
    aLabel = "0:a";
  } else {
    for (const f of segFiles) args.push("-i", f);
    inputCount = segFiles.length;
    // Group cut-joined segments into runs, concat each run, then xfade between runs.
    const runs = [];
    segments.forEach((seg, i) => {
      if (i > 0 && seg.clip?.transitionIn?.type === "dissolve") runs.push({ idx: [i], dissolve: seg.clip.transitionIn.duration });
      else if (!runs.length) runs.push({ idx: [i], dissolve: 0 });
      else runs[runs.length - 1].idx.push(i);
    });
    runs.forEach((run, r) => {
      run.length = run.idx.reduce((acc, i) => acc + segments[i].total, 0);
      // settb/fps keep every run on one timebase so xfade accepts them.
      if (run.idx.length === 1) {
        fc.push(`[${run.idx[0]}:v]settb=AVTB,fps=${FPS}[r${r}v]`, `[${run.idx[0]}:a]anull[r${r}a]`);
      } else {
        const ins = run.idx.map((i) => `[${i}:v][${i}:a]`).join("");
        fc.push(`${ins}concat=n=${run.idx.length}:v=1:a=1[c${r}v][r${r}a]`, `[c${r}v]settb=AVTB,fps=${FPS}[r${r}v]`);
      }
    });
    let acc = runs[0].length;
    vLabel = "r0v";
    aLabel = "r0a";
    for (let r = 1; r < runs.length; r++) {
      const d = runs[r].dissolve;
      const offset = round3(acc - d);
      fc.push(`[${vLabel}][r${r}v]xfade=transition=fade:duration=${d}:offset=${offset}[x${r}v]`);
      fc.push(`[${aLabel}][r${r}a]acrossfade=d=${d}:c1=tri:c2=tri[x${r}a]`);
      vLabel = `x${r}v`;
      aLabel = `x${r}a`;
      acc = round3(acc + runs[r].length - d);
    }
  }

  // Music / voice-over clips
  const musicLabels = [];
  music.forEach((mc, k) => {
    const m = byId.get(mc.mediaId);
    const src = mediaPath(projectId, m, quality);
    args.push("-ss", String(mc.in), "-t", String(mc.duration), "-i", src);
    const idx = inputCount++;
    const chain = [
      `volume=${mc.volume}`,
      mc.fadeIn > 0 ? `afade=t=in:st=0:d=${mc.fadeIn}` : null,
      mc.fadeOut > 0 ? `afade=t=out:st=${round3(Math.max(0, mc.duration - mc.fadeOut))}:d=${mc.fadeOut}` : null,
      "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
      `adelay=${Math.round(mc.start * 1000)}:all=1`,
    ].filter(Boolean);
    fc.push(`[${idx}:a]${chain.join(",")}[m${k}]`);
    musicLabels.push(`[m${k}]`);
  });

  let finalA = aLabel;
  if (musicLabels.length) {
    fc.push(`[${aLabel}]${musicLabels.join("")}amix=inputs=${musicLabels.length + 1}:duration=first:normalize=0[mix]`);
    finalA = "mix";
  }

  if (fc.length) args.push("-filter_complex", fc.join(";"));
  const vMap = hasDissolve ? `[${vLabel}]` : "0:v";
  const aMap = fc.length ? `[${finalA}]` : "0:a";
  args.push("-map", vMap, "-map", aMap);
  if (hasDissolve) args.push(...videoCodecArgs(quality), "-g", String(FPS * 2), "-pix_fmt", "yuv420p");
  else args.push("-c:v", "copy");
  args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", outFile);
  return args;
}

/**
 * Render a project's timeline. quality: "preview" | "final".
 * Returns { file, duration, width, height }.
 */
export async function renderTimeline(project, { quality = "preview", renderId, report = () => {}, signal } = {}) {
  const { timeline, media } = project;
  const H = quality === "preview" ? Math.min(config.proxyHeight, project.settings.height) : project.settings.height;
  const W = quality === "preview" ? Math.round((project.settings.width * H) / project.settings.height / 2) * 2 : project.settings.width;
  const FPS = project.settings.fps;
  const workDir = path.join(paths.work(project.id), renderId);
  await fs.mkdir(workDir, { recursive: true });
  const segments = planSegments(timeline);
  const totalDur = segments.reduce((a, s) => a + s.total, 0);
  const done = new Array(segments.length).fill(0);
  const textFiles = [];

  const segFiles = segments.map((s) => path.join(workDir, `seg_${String(s.index).padStart(3, "0")}.mp4`));
  const allArgs = segments.map((seg, i) => segmentArgs({ seg, timeline, media, projectId: project.id, quality, W, H, FPS, workDir, outFile: segFiles[i], textFiles }));
  await Promise.all(textFiles.map((t) => fs.writeFile(t.file, t.text)));

  report(0.01, `Rendering ${segments.length} segment${segments.length === 1 ? "" : "s"}`);
  const tick = () => {
    const sum = done.reduce((a, b) => a + b, 0);
    report(0.01 + 0.79 * (totalDur ? sum / totalDur : 0), `Rendering ${segments.length} segments`);
  };
  await pool(segments, config.concurrency, async (seg, i) => {
    await ffmpeg(allArgs[i], { signal, onProgress: (s) => { done[i] = Math.min(seg.total, s); tick(); } });
    done[i] = seg.total;
    tick();
  });

  report(0.8, "Assembling + mixing audio");
  const listFile = path.join(workDir, "concat.txt");
  await fs.writeFile(listFile, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const outFile = path.join(paths.renders(project.id), `${renderId}.mp4`);
  const args = assemblyArgs({ segments, segFiles, timeline, media, projectId: project.id, quality, listFile, outFile, W, H, FPS });
  await ffmpeg(args, { signal, onProgress: (s) => report(0.8 + 0.2 * (totalDur ? s / totalDur : 0), "Assembling + mixing audio") });
  await fs.rm(workDir, { recursive: true, force: true });
  return { file: path.basename(outFile), duration: timelineDuration(timeline), width: W, height: H };
}
