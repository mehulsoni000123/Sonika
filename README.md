# Sonika — cloud editor where Claude cuts and you adjust

Sonika is a self-hosted, invideo-style editing app:

1. **Bring footage in** from Google Drive (browse, search, or paste a share link) or upload directly.
2. **Claude builds the edit.** It gets every file's analysis (scene changes, speech/silence ranges, transcript if you add one) plus a timecoded contact sheet of frames, reads your brief, and returns a timeline: shots, in/out points, titles, lower thirds, transitions, music bed.
3. **You take over.** Trim, move, split, re-order, rewrite titles, change transitions in the browser, with instant preview straight from 540p proxies. Or just tell Claude what to change in the chat; every change is a checkpoint you can restore.
4. **Render in the cloud.** Segments render in parallel with FFmpeg (preview from proxies in seconds, final from the originals), then get sent back to a `Sonika` folder in your Drive.

Everything runs in one Node process plus FFmpeg. No database, no build step.

## Run it

```bash
cp .env.example .env     # fill in ANTHROPIC_API_KEY, APP_PASSWORD, Google OAuth
npm install
npm start                # http://localhost:8080
```

Or with Docker (FFmpeg included):

```bash
docker compose up --build
```

Without an Anthropic key you can still try the editor with `MOCK_AI=1` (deterministic mock cuts).

### Google Drive setup (one time)

1. Google Cloud Console → create a project → **APIs & Services → Enable** the *Google Drive API*.
2. **Credentials → Create credentials → OAuth client ID → Web application.**
3. Add `https://<your-host>/auth/google/callback` (or `http://localhost:8080/auth/google/callback` locally) under *Authorized redirect URIs*.
4. Put the client id/secret and the redirect URI in `.env`, restart, open the app and click **Google Drive → Connect**.

The refresh token is stored in `DATA_DIR/google-tokens.json`, so you connect once per server.

### Deploying to the cloud

Any host that runs a Docker image with a persistent disk works. Give it CPU: renders scale with cores (`RENDER_CONCURRENCY` defaults to the CPU count).

| Host | Notes |
|---|---|
| Fly.io / Railway / Render | Build from the Dockerfile, mount a volume at `/data`, set the env vars from `.env.example`. |
| Google Cloud Run | Works for the UI + Claude, but attach a persistent volume (Cloud Run volume mounts or GCS FUSE) at `/data`; use a 4–8 vCPU service for render speed. |
| A VPS (Hetzner, DigitalOcean, EC2) | `docker compose up -d` behind Caddy/nginx with HTTPS. A GPU box can set `FFMPEG_VIDEO_ENCODER=h264_nvenc`. |

Set `APP_PASSWORD` before exposing it to the internet.

## How the pieces fit

```
web/           browser editor (vanilla ES modules): timeline, preview player, inspector, Claude chat, Drive browser
server/
  index.js     Express API + SSE job events + static files
  media.js     ingest: ffprobe, 540p proxy, poster, filmstrip, contact sheet, scene + silence detection
  timeline.js  timeline schema (zod), validation/normalization, ripple, transitions
  render.js    timeline → ffmpeg: parallel segments (text burned in) → concat/xfade + music mix
  ai/          Claude planner (structured outputs): brief → plan, chat → revised plan
  drive.js     Google OAuth, browse/search, download, upload
  store.js     JSON project store with revisions and checkpoints
  jobs.js      in-process job queue with progress events
test/          node:test suites (timeline rules, full render with synthetic footage, mock planner)
```

### Timeline model

Three tracks: `video` (base cut: video clips and images, back to back), `text` (hook / title / subtitle / lower-third / caption / callout), `audio` (music or voice-over beds with fades). Video clips carry `in`, `duration`, `speed`, `volume`, `muted`, `fit`, `kenBurns`, `transitionIn` (`cut` | `fade` | `dissolve`) and `fadeOut`. A dissolve never shortens the timeline: the previous clip is rendered with a cloned tail so the overlap is absorbed.

Saves are optimistic: the client sends the timeline with the revision it started from; a stale revision is rejected and the UI reloads (this is what keeps your edits and Claude's from clobbering each other).

### Render speed

Previews use the proxies and `ultrafast`; finals use the originals and `medium`/CRF 18. Each clip renders as its own segment in parallel, text overlays are burned in at that stage, then a single assembly pass joins the segments (stream copy when there are no dissolves) and mixes the music. A 60-second final at 1080p on 4 cores typically takes well under a minute.

## Tests

```bash
npm test
```

The render test generates clips with FFmpeg, ingests them, builds a timeline with every feature (dissolve, fade, speed change, Ken Burns image, titles, music) and checks the output.

## API

| Method | Path | What |
|---|---|---|
| `GET/POST` | `/api/projects` | list / create (`name`, `aspect` 16:9 · 9:16 · 1:1 · 4:5, `fps`) |
| `GET/PATCH/DELETE` | `/api/projects/:id` | project |
| `POST` | `/api/projects/:id/upload` | multipart `files` |
| `POST` | `/api/projects/:id/import-drive` | `{ fileIds: [], links: [] }` |
| `PATCH/DELETE` | `/api/projects/:id/media/:mid` | transcript / rename, remove |
| `PUT` | `/api/projects/:id/timeline` | `{ timeline, revision, label }` |
| `GET` / `POST` | `/api/projects/:id/history` · `/history/restore` | checkpoints |
| `POST` | `/api/projects/:id/ai/plan` · `/ai/revise` | `{ brief }` / `{ instruction }` |
| `POST` | `/api/projects/:id/render` | `{ quality: "preview" | "final" }` |
| `POST` | `/api/projects/:id/renders/:rid/drive` | upload to Drive |
| `GET` | `/api/projects/:id/events` | SSE job progress |
| `GET` | `/api/drive/status` · `/api/drive/list?parent=&q=` | Drive |
| `GET` | `/files/:id/(media|proxies|thumbs|renders)/:file` | files (Range supported) |
