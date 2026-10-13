import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, "data")),
  webDir: path.join(ROOT, "web"),
  // Simple shared password for the whole app (single-user). Empty = open.
  appPassword: env.APP_PASSWORD || "",
  // Anthropic
  model: env.ANTHROPIC_MODEL || "claude-opus-5-5",
  mockAi: env.MOCK_AI === "1",
  // Google OAuth (Drive)
  google: {
    clientId: env.GOOGLE_CLIENT_ID || "",
    clientSecret: env.GOOGLE_CLIENT_SECRET || "",
    redirectUri: env.GOOGLE_REDIRECT_URI || `http://localhost:${env.PORT || 8080}/auth/google/callback`,
  },
  // FFmpeg
  ffmpeg: env.FFMPEG_PATH || "ffmpeg",
  ffprobe: env.FFPROBE_PATH || "ffprobe",
  videoEncoder: env.FFMPEG_VIDEO_ENCODER || "libx264", // h264_nvenc on GPU machines
  fontFile: env.FONT_FILE || "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  // Parallel ffmpeg processes for segment renders
  concurrency: Math.max(1, Number(env.RENDER_CONCURRENCY || os.cpus().length)),
  proxyHeight: Number(env.PROXY_HEIGHT || 540),
  // h264 plays in every real browser; vp9 (webm) is for Chromium builds without H.264 (CI, Playwright).
  proxyCodec: env.PROXY_CODEC === "vp9" ? "vp9" : "h264",
};

export const paths = {
  projects: path.join(config.dataDir, "projects"),
  tokens: path.join(config.dataDir, "google-tokens.json"),
  project: (id) => path.join(config.dataDir, "projects", id),
  media: (id) => path.join(config.dataDir, "projects", id, "media"),
  proxies: (id) => path.join(config.dataDir, "projects", id, "proxies"),
  thumbs: (id) => path.join(config.dataDir, "projects", id, "thumbs"),
  renders: (id) => path.join(config.dataDir, "projects", id, "renders"),
  work: (id) => path.join(config.dataDir, "projects", id, "work"),
};
