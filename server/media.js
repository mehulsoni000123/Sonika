// Media ingest: probe, proxy, thumbnails, filmstrip for the UI, contact sheet
// for Claude, scene + silence detection. Everything lands in the project dirs.
import path from "node:path";
import fs from "node:fs/promises";
import { config, paths } from "./config.js";
import { ffprobe, ffmpeg, ffmpegLog, escapeFilterPath } from "./ffmpeg.js";
import { newId } from "./store.js";

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v|avi|mts|m2ts|mxf)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|aiff?)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;

export function kindFromName(name) {
  if (VIDEO_EXT.test(name)) return "video";
  if (AUDIO_EXT.test(name)) return "audio";
  if (IMAGE_EXT.test(name)) return "image";
  return "video";
}

export function safeName(name) {
  return String(name).replace(/[^\w.\-()\[\] ]+/g, "_").slice(0, 120) || "file";
}

function parseFps(stream) {
  const r = stream?.avg_frame_rate || stream?.r_frame_rate || "0/1";
  const [n, d] = r.split("/").map(Number);
  return d ? Math.round((n / d) * 1000) / 1000 : 0;
}

/**
 * Analyze a file already on disk in the project's media dir and produce the
 * media record. `report(progress, message)` streams progress.
 */
export async function ingest(projectId, file, originalName, source, report = () => {}) {
  const id = newId("m");
  const kind = kindFromName(originalName);
  const info = await ffprobe(file);
  const v = info.streams.find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic));
  const a = info.streams.find((s) => s.codec_type === "audio");
  const duration = Number(info.format.duration) || Number(v?.duration) || Number(a?.duration) || 0;
  const rotation = Number(v?.side_data_list?.find((s) => s.rotation != null)?.rotation || v?.tags?.rotate || 0);
  const rotated = Math.abs(rotation) % 180 === 90;
  const media = {
    id,
    name: originalName,
    kind: kind === "video" && !v ? "audio" : kind,
    file: path.basename(file),
    size: Number(info.format.size) || 0,
    duration: media_kind_duration(kind, duration),
    width: v ? (rotated ? v.height : v.width) : 0,
    height: v ? (rotated ? v.width : v.height) : 0,
    fps: v ? parseFps(v) : 0,
    hasAudio: !!a,
    codec: v?.codec_name || a?.codec_name || "",
    source,
    proxy: null,
    poster: null,
    strip: null,
    stripInterval: 0,
    stripFrames: 0,
    contact: null,
    scenes: [],
    speech: [],
    silences: [],
    transcript: "",
    createdAt: new Date().toISOString(),
  };

  const thumbs = paths.thumbs(projectId);
  const proxies = paths.proxies(projectId);

  if (media.kind === "image") {
    report(0.3, "Making thumbnail");
    media.poster = `${id}.poster.jpg`;
    await ffmpeg(["-i", file, "-vf", "scale=480:-2", "-frames:v", "1", "-q:v", "4", path.join(thumbs, media.poster)]);
    media.contact = media.poster;
    report(1, "Ready");
    return media;
  }

  if (media.kind === "audio") {
    report(0.2, "Analyzing audio");
    media.proxy = config.proxyCodec === "vp9" ? `${id}.proxy.webm` : `${id}.proxy.m4a`;
    await ffmpeg(["-i", file, "-vn", ...(config.proxyCodec === "vp9" ? ["-c:a", "libopus", "-b:a", "96k"] : ["-c:a", "aac", "-b:a", "128k"]), path.join(proxies, media.proxy)]);
    await detectSilence(file, media);
    report(1, "Ready");
    return media;
  }

  // ---- video ----
  report(0.02, "Poster frame");
  media.poster = `${id}.poster.jpg`;
  await ffmpeg(["-ss", String(Math.min(1, duration / 2)), "-i", file, "-vf", "scale=480:-2", "-frames:v", "1", "-q:v", "4", path.join(thumbs, media.poster)]);

  // Proxy first — the UI preview needs it, and scene detection runs on it (fast).
  report(0.05, "Building preview proxy");
  const vp9 = config.proxyCodec === "vp9";
  media.proxy = vp9 ? `${id}.proxy.webm` : `${id}.proxy.mp4`;
  const ph = config.proxyHeight;
  const proxyArgs = ["-i", file, "-vf", `scale=-2:'min(${ph},ih)',fps=30,format=yuv420p`];
  if (vp9) proxyArgs.push("-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-crf", "36", "-b:v", "0", "-g", "30");
  else proxyArgs.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-g", "30", "-movflags", "+faststart");
  if (a) proxyArgs.push(...(vp9 ? ["-c:a", "libopus", "-b:a", "96k"] : ["-c:a", "aac", "-b:a", "96k"]), "-ac", "2");
  else proxyArgs.push("-an");
  proxyArgs.push(path.join(proxies, media.proxy));
  await ffmpeg(proxyArgs, { onProgress: (s) => report(0.05 + 0.55 * (duration ? s / duration : 0), "Building preview proxy") });
  const proxyFile = path.join(proxies, media.proxy);

  report(0.62, "Filmstrip + scene detection");
  await Promise.all([
    makeStrip(proxyFile, media, thumbs),
    makeContactSheet(proxyFile, media, thumbs),
    detectScenes(proxyFile, media),
    a ? detectSilence(file, media) : Promise.resolve(),
  ]);
  report(1, "Ready");
  return media;
}

function media_kind_duration(kind, d) {
  return kind === "image" ? 0 : Math.round(d * 1000) / 1000;
}

/** Horizontal strip of frames used to paint clips on the timeline. */
async function makeStrip(src, media, thumbs) {
  const frames = Math.max(1, Math.min(120, Math.ceil(media.duration)));
  const interval = media.duration / frames;
  media.strip = `${media.id}.strip.jpg`;
  media.stripInterval = interval;
  media.stripFrames = frames;
  await ffmpeg(["-i", src, "-vf", `fps=1/${interval.toFixed(4)},scale=160:90:force_original_aspect_ratio=increase,crop=160:90,tile=${frames}x1`, "-frames:v", "1", "-q:v", "5", path.join(thumbs, media.strip)]);
}

/** Contact sheet with burned-in timecodes — this is what Claude "watches". */
async function makeContactSheet(src, media, thumbs) {
  const cols = 4;
  const frames = Math.max(4, Math.min(24, Math.ceil(media.duration / 2)));
  const rows = Math.ceil(frames / cols);
  const interval = media.duration / frames;
  media.contact = `${media.id}.contact.jpg`;
  const font = escapeFilterPath(config.fontFile);
  const vf = `fps=1/${interval.toFixed(4)},scale=320:180:force_original_aspect_ratio=increase,crop=320:180,drawtext=fontfile='${font}':text='%{pts\\:hms}':fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4:x=6:y=h-th-6,tile=${cols}x${rows}:padding=4:color=black`;
  await ffmpeg(["-i", src, "-vf", vf, "-frames:v", "1", "-q:v", "4", path.join(thumbs, media.contact)]);
}

async function detectScenes(src, media) {
  try {
    const log = await ffmpegLog(["-i", src, "-vf", "select='gt(scene,0.35)',showinfo", "-an", "-f", "null", "-"]);
    const times = [...log.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.5);
    media.scenes = dedupe(times, 1).slice(0, 200).map((t) => Math.round(t * 100) / 100);
  } catch (err) {
    console.warn("scene detection failed", err.message);
  }
}

async function detectSilence(src, media) {
  try {
    const log = await ffmpegLog(["-i", src, "-vn", "-af", "silencedetect=n=-35dB:d=0.5", "-f", "null", "-"]);
    const starts = [...log.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...log.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
    const silences = starts.map((s, i) => [s, ends[i] ?? media.duration]).map(([s, e]) => [r2(s), r2(e)]);
    media.silences = silences;
    // Speech = complement of silence, dropping sub-0.3s slivers.
    const speech = [];
    let cursor = 0;
    for (const [s, e] of silences) {
      if (s - cursor >= 0.3) speech.push([r2(cursor), r2(s)]);
      cursor = e;
    }
    if (media.duration - cursor >= 0.3) speech.push([r2(cursor), r2(media.duration)]);
    media.speech = speech;
  } catch (err) {
    console.warn("silence detection failed", err.message);
  }
}

const r2 = (n) => Math.round(n * 100) / 100;

function dedupe(times, minGap) {
  const out = [];
  for (const t of times) if (!out.length || t - out[out.length - 1] >= minGap) out.push(t);
  return out;
}

export async function removeMediaFiles(projectId, media) {
  const files = [
    path.join(paths.media(projectId), media.file),
    media.proxy && path.join(paths.proxies(projectId), media.proxy),
    media.poster && path.join(paths.thumbs(projectId), media.poster),
    media.strip && path.join(paths.thumbs(projectId), media.strip),
    media.contact && media.contact !== media.poster && path.join(paths.thumbs(projectId), media.contact),
  ].filter(Boolean);
  await Promise.all(files.map((f) => fs.rm(f, { force: true })));
}
