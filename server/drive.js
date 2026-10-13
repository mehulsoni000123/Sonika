// Google Drive: OAuth, browsing, downloading sources into a project and
// uploading renders back. Tokens live in DATA_DIR/google-tokens.json.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { google } from "googleapis";
import { config, paths } from "./config.js";
import { loadGoogleTokens, saveGoogleTokens } from "./store.js";

const SCOPES = ["https://www.googleapis.com/auth/drive"];
const MEDIA_Q = "(mimeType contains 'video/' or mimeType contains 'audio/' or mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.folder')";

export function isConfigured() {
  return !!(config.google.clientId && config.google.clientSecret);
}

function oauth() {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

export function authUrl() {
  return oauth().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
}

export async function handleCallback(code) {
  const client = oauth();
  const { tokens } = await client.getToken(code);
  const existing = await loadGoogleTokens();
  await saveGoogleTokens({ ...existing, ...tokens, refresh_token: tokens.refresh_token || existing?.refresh_token });
}

export async function disconnect() {
  await saveGoogleTokens(null);
}

async function driveClient() {
  const tokens = await loadGoogleTokens();
  if (!tokens) throw new Error("Google Drive is not connected");
  const client = oauth();
  client.setCredentials(tokens);
  client.on("tokens", async (t) => saveGoogleTokens({ ...tokens, ...t }));
  return google.drive({ version: "v3", auth: client });
}

export async function status() {
  if (!isConfigured()) return { configured: false, connected: false };
  const tokens = await loadGoogleTokens();
  if (!tokens) return { configured: true, connected: false };
  try {
    const drive = await driveClient();
    const { data } = await drive.about.get({ fields: "user(displayName,emailAddress)" });
    return { configured: true, connected: true, user: data.user };
  } catch (err) {
    return { configured: true, connected: false, error: err.message };
  }
}

/** List media + folders. `parent` = folder id ("root" default); `q` = free-text search. */
export async function list({ parent = "root", q = "", pageToken } = {}) {
  const drive = await driveClient();
  const query = q ? `name contains '${q.replace(/'/g, "\\'")}' and ${MEDIA_Q} and trashed = false` : `'${parent}' in parents and ${MEDIA_Q} and trashed = false`;
  const { data } = await drive.files.list({
    q: query,
    pageSize: 60,
    pageToken,
    orderBy: q ? "modifiedTime desc" : "folder,name",
    fields: "nextPageToken, files(id,name,mimeType,size,modifiedTime,thumbnailLink,videoMediaMetadata(durationMillis,width,height),parents)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return {
    nextPageToken: data.nextPageToken || null,
    files: (data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      folder: f.mimeType === "application/vnd.google-apps.folder",
      mimeType: f.mimeType,
      size: Number(f.size || 0),
      modifiedTime: f.modifiedTime,
      thumbnail: f.thumbnailLink || null,
      duration: f.videoMediaMetadata?.durationMillis ? Number(f.videoMediaMetadata.durationMillis) / 1000 : null,
    })),
  };
}

/** Accepts a Drive share link or a bare id and returns the id. */
export function extractFileId(linkOrId) {
  const s = String(linkOrId).trim();
  const m = s.match(/\/d\/([\w-]{20,})/) || s.match(/[?&]id=([\w-]{20,})/) || s.match(/^([\w-]{20,})$/);
  return m ? m[1] : null;
}

export async function getMeta(fileId) {
  const drive = await driveClient();
  const { data } = await drive.files.get({ fileId, fields: "id,name,mimeType,size", supportsAllDrives: true });
  return data;
}

/** Stream a Drive file into the project media dir. Returns the local path. */
export async function download(fileId, projectId, name, onProgress = () => {}) {
  const drive = await driveClient();
  const meta = await getMeta(fileId);
  const size = Number(meta.size || 0);
  const dest = path.join(paths.media(projectId), name);
  const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "stream" });
  let got = 0;
  res.data.on("data", (chunk) => {
    got += chunk.length;
    if (size) onProgress(got / size);
  });
  await pipeline(res.data, fs.createWriteStream(dest));
  return dest;
}

/** Upload a render to Drive (into a "Sonika" folder by default). Returns {id, link}. */
export async function upload(localFile, name, folderId) {
  const drive = await driveClient();
  let parent = folderId;
  if (!parent) {
    const { data } = await drive.files.list({ q: "name = 'Sonika' and mimeType = 'application/vnd.google-apps.folder' and trashed = false", fields: "files(id)", pageSize: 1 });
    parent = data.files?.[0]?.id;
    if (!parent) {
      const created = await drive.files.create({ requestBody: { name: "Sonika", mimeType: "application/vnd.google-apps.folder" }, fields: "id" });
      parent = created.data.id;
    }
  }
  const stat = await fsp.stat(localFile);
  const { data } = await drive.files.create({
    requestBody: { name, parents: [parent] },
    media: { mimeType: "video/mp4", body: fs.createReadStream(localFile) },
    fields: "id,webViewLink",
    supportsAllDrives: true,
  });
  return { id: data.id, link: data.webViewLink, size: stat.size };
}
