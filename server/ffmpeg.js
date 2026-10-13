// Thin wrapper around ffmpeg/ffprobe with progress parsing.
import { spawn } from "node:child_process";
import { config } from "./config.js";

export function ffprobe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`ffprobe failed (${code}): ${err.trim()}`))));
  });
}

/**
 * Run ffmpeg. `onProgress(seconds)` receives the output time as it is produced
 * (uses `-progress pipe:1`). Resolves with stderr text on success.
 */
export function ffmpeg(args, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const full = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-loglevel", "error", ...args];
    const p = spawn(config.ffmpeg, full, { signal });
    let err = "";
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("out_time_us=") || line.startsWith("out_time_ms=")) {
          const us = Number(line.split("=")[1]);
          if (Number.isFinite(us) && onProgress) onProgress(us / 1e6);
        }
      }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve(err);
      else reject(new Error(`ffmpeg failed (${code}): ${err.trim().split("\n").slice(-6).join("\n")}\nargs: ${full.join(" ")}`));
    });
  });
}

/** Run ffmpeg purely for its stderr log (used by analysis filters like silencedetect). */
export function ffmpegLog(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ["-hide_banner", "-nostdin", "-nostats", ...args]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg failed (${code}): ${err.trim().slice(-800)}`))));
  });
}

/** Escape a string for use inside a drawtext `text=` option. */
export function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Escape a filesystem path for use inside a filter option (fontfile=, subtitles=). */
export function escapeFilterPath(p) {
  return String(p).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** Simple promise pool. */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
}
