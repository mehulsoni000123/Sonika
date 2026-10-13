// Browse folders on the machine running Sonika (for the desktop app: the
// Google Drive desktop folder, Downloads, external drives) and copy files in.
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import os from "node:os";
import { kindFromName } from "./media.js";

const MEDIA = /\.(mp4|mov|mkv|webm|m4v|avi|mts|m2ts|mxf|mp3|wav|m4a|aac|flac|ogg|aiff?|jpe?g|png|webp|gif|bmp|tiff?)$/i;

/** Likely Google Drive desktop folders on this machine. */
export function driveFolderCandidates() {
  const home = os.homedir();
  const c = [
    path.join(home, "My Drive"),
    path.join(home, "Google Drive"),
    path.join(home, "Google Drive", "My Drive"),
    path.join(home, "Library", "CloudStorage"),
  ];
  if (process.platform === "win32") {
    for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ") {
      c.push(`${letter}:\\My Drive`, `${letter}:\\Shared drives`);
    }
  }
  return c.filter((p) => fss.existsSync(p));
}

/** Top-level entry points: drives (Windows), home, Desktop, Downloads, Videos, Drive folders. */
export function roots(savedDriveFolder) {
  const home = os.homedir();
  const out = [];
  const add = (name, p) => fss.existsSync(p) && !out.some((r) => r.path === p) && out.push({ name, path: p });
  if (savedDriveFolder) add("Google Drive folder", savedDriveFolder);
  for (const p of driveFolderCandidates()) add(`Google Drive (${p})`, p);
  add("Desktop", path.join(home, "Desktop"));
  add("Downloads", path.join(home, "Downloads"));
  add("Videos", path.join(home, "Videos"));
  add("Home", home);
  if (process.platform === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") add(`${letter}: drive`, `${letter}:\\`);
  } else add("Root", "/");
  return out;
}

export async function list(dir) {
  const abs = path.resolve(dir);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const folders = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name.startsWith("$") || e.name === "System Volume Information") continue;
    const full = path.join(abs, e.name);
    if (e.isDirectory()) folders.push({ name: e.name, path: full, folder: true });
    else if (e.isFile() && MEDIA.test(e.name)) {
      let size = 0;
      try {
        size = (await fs.stat(full)).size;
      } catch {
        /* unreadable */
      }
      files.push({ name: e.name, path: full, folder: false, size, kind: kindFromName(e.name) });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return { path: abs, parent: path.dirname(abs) !== abs ? path.dirname(abs) : null, items: [...folders.sort(byName), ...files.sort(byName)] };
}

export async function copyIn(src, destDir, destName, onProgress = () => {}) {
  const stat = await fs.stat(src);
  const dest = path.join(destDir, destName);
  await new Promise((resolve, reject) => {
    let done = 0;
    const rs = fss.createReadStream(src);
    const ws = fss.createWriteStream(dest);
    rs.on("data", (c) => {
      done += c.length;
      if (stat.size) onProgress(done / stat.size);
    });
    rs.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);
    rs.pipe(ws);
  });
  return dest;
}
