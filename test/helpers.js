import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// Point the app at a throwaway data dir before any server module loads config.
export const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "sonika-test-"));
process.env.DATA_DIR = DATA_DIR;
process.env.MOCK_AI = "1";
process.env.RENDER_CONCURRENCY = "2";

const { paths } = await import("../server/config.js");
const { ffmpeg } = await import("../server/ffmpeg.js");

/** Generate a synthetic test clip (color bars + tone) with the given duration. */
export async function makeVideo(projectId, name, seconds, { audio = true, w = 640, h = 360 } = {}) {
  const file = path.join(paths.media(projectId), name);
  const args = ["-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=25:duration=${seconds}`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "aac");
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file);
  await ffmpeg(args);
  return file;
}

export async function makeImage(projectId, name) {
  const file = path.join(paths.media(projectId), name);
  await ffmpeg(["-f", "lavfi", "-i", "color=c=orange:s=800x600", "-frames:v", "1", file]);
  return file;
}

export async function makeAudio(projectId, name, seconds) {
  const file = path.join(paths.media(projectId), name);
  await ffmpeg(["-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`, "-c:a", "libmp3lame", file]);
  return file;
}
