// User-editable settings saved in DATA_DIR/settings.json (set from the app's
// Settings screen). Environment variables still work and act as defaults.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const FILE = () => path.join(config.dataDir, "settings.json");
let cache = null;

export async function loadSettings() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE(), "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

export async function saveSettings(patch) {
  const s = await loadSettings();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === "" || v === null) delete s[k];
    else s[k] = v;
  }
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = `${FILE()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2));
  await fs.rename(tmp, FILE());
  cache = s;
  return s;
}

export async function anthropicKey() {
  const s = await loadSettings();
  return s.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
}

export async function googleCreds() {
  const s = await loadSettings();
  return {
    clientId: s.googleClientId || config.google.clientId,
    clientSecret: s.googleClientSecret || config.google.clientSecret,
    redirectUri: s.googleRedirectUri || config.google.redirectUri,
  };
}

/** Masked view for the UI. */
export async function publicSettings() {
  const s = await loadSettings();
  const key = await anthropicKey();
  const g = await googleCreds();
  return {
    anthropicKeySet: !!key,
    anthropicKeyHint: key ? `${key.slice(0, 10)}…${key.slice(-4)}` : "",
    anthropicFromEnv: !s.anthropicApiKey && !!process.env.ANTHROPIC_API_KEY,
    googleClientId: g.clientId || "",
    googleClientSecretSet: !!g.clientSecret,
    googleRedirectUri: g.redirectUri,
    localDriveFolder: s.localDriveFolder || "",
    model: config.model,
  };
}
