// Realtime preview straight from the timeline: two alternating <video>
// elements play the 540p proxies, images and text overlays are DOM, music
// clips get their own <audio>. No render needed to scrub the cut.
import { api } from "./api.js";

export const PRESET_SIZE = { hook: 0.08, title: 0.065, subtitle: 0.04, "lower-third": 0.038, caption: 0.045, callout: 0.05 };

export class Player {
  constructor({ frame, vidA, vidB, imgEl, overlay, onTime, onEnded }) {
    this.frame = frame;
    this.vids = [vidA, vidB];
    this.img = imgEl;
    this.overlay = overlay;
    this.onTime = onTime || (() => {});
    this.onEnded = onEnded || (() => {});
    this.project = null;
    this.timeline = { tracks: [] };
    this.duration = 0;
    this.t = 0;
    this.playing = false;
    this.active = 0; // index of the active video element
    this.activeClipId = null;
    this.preloadedClipId = null;
    this.audios = new Map();
    this.textKey = "";
    this.raf = null;
    for (const v of this.vids) {
      v.addEventListener("error", () => {});
    }
  }

  setProject(project) {
    this.project = project;
    this.mediaById = new Map(project.media.map((m) => [m.id, m]));
    this.setTimeline(project.timeline);
    this.resize();
  }

  setTimeline(timeline) {
    this.timeline = timeline;
    this.duration = 0;
    for (const tr of timeline.tracks) for (const c of tr.clips) this.duration = Math.max(this.duration, c.start + c.duration);
    this.activeClipId = null; // force resync
    this.preloadedClipId = null;
    this.textKey = "";
    this.sync(true);
  }

  resize() {
    if (!this.project) return;
    const { width, height } = this.project.settings;
    const stage = this.frame.parentElement;
    const maxW = stage.clientWidth - 32;
    const maxH = stage.clientHeight - 32;
    const scale = Math.min(maxW / width, maxH / height);
    this.frame.style.width = `${Math.floor(width * scale)}px`;
    this.frame.style.height = `${Math.floor(height * scale)}px`;
    this.textKey = "";
    this.renderText();
  }

  get videoTrack() {
    return this.timeline.tracks.find((t) => t.kind === "video");
  }

  clipAt(track, t) {
    if (!track) return null;
    return track.clips.find((c) => t >= c.start && t < c.start + c.duration) || null;
  }

  seek(t) {
    this.t = Math.max(0, Math.min(this.duration, t));
    this.sync(true);
    this.onTime(this.t);
  }

  play() {
    if (!this.duration) return;
    if (this.t >= this.duration - 0.01) this.t = 0;
    this.playing = true;
    this.t0 = this.t;
    this.start = performance.now();
    this.sync(true);
    const loop = () => {
      if (!this.playing) return;
      this.t = this.t0 + (performance.now() - this.start) / 1000;
      if (this.t >= this.duration) {
        this.t = this.duration;
        this.pause();
        this.onTime(this.t);
        this.onEnded();
        return;
      }
      this.sync(false);
      this.onTime(this.t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const v of this.vids) v.pause();
    for (const a of this.audios.values()) a.el.pause();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  sync(hard) {
    const t = this.t;
    const clip = this.clipAt(this.videoTrack, t);
    const media = clip ? this.mediaById.get(clip.mediaId) : null;
    const el = this.vids[this.active];
    const other = this.vids[1 - this.active];

    if (!clip || !media) {
      this.showNone();
    } else if (media.kind === "image") {
      const src = api.fileUrl(this.project.id, "media", media.file);
      if (!this.img.src.endsWith(encodeURIComponent(media.file))) this.img.src = src;
      this.img.classList.add("active");
      for (const v of this.vids) {
        v.classList.remove("active");
        v.pause();
      }
      this.activeClipId = clip.id;
    } else {
      this.img.classList.remove("active");
      const want = clip.in + (t - clip.start) * (clip.speed || 1);
      if (clip.id !== this.activeClipId) {
        // Switch to the preloaded element if it holds this clip, else load it here.
        if (this.preloadedClipId === clip.id) {
          this.active = 1 - this.active;
          this.preloadedClipId = null;
        }
        const v = this.vids[this.active];
        this.loadInto(v, media, want);
        this.activeClipId = clip.id;
      }
      const v = this.vids[this.active];
      const o = this.vids[1 - this.active];
      v.classList.add("active");
      o.classList.remove("active");
      o.pause();
      v.playbackRate = clip.speed || 1;
      v.muted = !!clip.muted || !media.hasAudio;
      v.volume = Math.min(1, clip.volume ?? 1);
      const drift = Math.abs(v.currentTime - want);
      if (hard || drift > 0.35) {
        if (v.readyState >= 1) v.currentTime = want;
        else v.addEventListener("loadedmetadata", () => (v.currentTime = want), { once: true });
      }
      if (this.playing && v.paused) v.play().catch(() => {});
      if (!this.playing && !v.paused) v.pause();
      // Preload the next clip.
      const next = this.nextClip(clip);
      if (next && next.id !== this.preloadedClipId) {
        const nm = this.mediaById.get(next.mediaId);
        if (nm && nm.kind !== "image") {
          this.loadInto(other, nm, next.in);
          this.preloadedClipId = next.id;
        }
      }
    }
    this.syncAudio(hard);
    this.renderText();
  }

  loadInto(v, media, at) {
    const src = api.fileUrl(this.project.id, "proxies", media.proxy);
    if (!v.src.endsWith(encodeURIComponent(media.proxy))) {
      v.src = src;
      v.load();
    }
    if (v.readyState >= 1) v.currentTime = at;
    else v.addEventListener("loadedmetadata", () => (v.currentTime = at), { once: true });
  }

  nextClip(clip) {
    const clips = this.videoTrack.clips;
    const i = clips.indexOf(clip);
    return clips[i + 1] || null;
  }

  showNone() {
    this.img.classList.remove("active");
    for (const v of this.vids) {
      v.classList.remove("active");
      v.pause();
    }
    this.activeClipId = null;
  }

  syncAudio(hard) {
    const track = this.timeline.tracks.find((t) => t.kind === "audio");
    const live = new Set();
    for (const c of track?.clips || []) {
      const m = this.mediaById.get(c.mediaId);
      if (!m) continue;
      const on = this.t >= c.start && this.t < c.start + c.duration;
      let a = this.audios.get(c.id);
      if (on) {
        live.add(c.id);
        if (!a) {
          a = { el: new Audio(api.fileUrl(this.project.id, "proxies", m.proxy)), media: m.id };
          a.el.preload = "auto";
          this.audios.set(c.id, a);
        }
        const want = c.in + (this.t - c.start);
        let vol = c.volume ?? 0.2;
        if (c.fadeIn && this.t - c.start < c.fadeIn) vol *= (this.t - c.start) / c.fadeIn;
        if (c.fadeOut && c.start + c.duration - this.t < c.fadeOut) vol *= (c.start + c.duration - this.t) / c.fadeOut;
        a.el.volume = Math.max(0, Math.min(1, vol));
        if (hard || Math.abs(a.el.currentTime - want) > 0.4) {
          if (a.el.readyState >= 1) a.el.currentTime = want;
          else a.el.addEventListener("loadedmetadata", () => (a.el.currentTime = want), { once: true });
        }
        if (this.playing && a.el.paused) a.el.play().catch(() => {});
        if (!this.playing && !a.el.paused) a.el.pause();
      }
    }
    for (const [id, a] of this.audios) if (!live.has(id)) a.el.pause();
  }

  renderText() {
    const track = this.timeline.tracks.find((t) => t.kind === "text");
    const on = (track?.clips || []).filter((c) => this.t >= c.start && this.t < c.start + c.duration);
    const key = on.map((c) => `${c.id}:${c.text}:${c.preset}:${c.position}:${c.align}:${c.color}:${c.box}:${c.boxColor}`).join("|") + `@${this.frame.clientHeight}`;
    if (key === this.textKey) return;
    this.textKey = key;
    const H = this.frame.clientHeight;
    this.overlay.innerHTML = "";
    for (const c of on) {
      const d = document.createElement("div");
      d.className = `txt ${c.position} ${c.align === "left" ? "left" : ""} ${c.box ? "box" : ""}`;
      d.style.fontSize = `${Math.round(H * (PRESET_SIZE[c.preset] || 0.06))}px`;
      d.style.color = c.color || "#fff";
      const s = document.createElement("span");
      s.textContent = c.text;
      if (c.box) s.style.background = hexA(c.boxColor || "#000000", 0.55);
      d.appendChild(s);
      this.overlay.appendChild(d);
    }
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
