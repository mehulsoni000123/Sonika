// DOM timeline editor: filmstrip clips, drag to move, trim handles, snapping,
// drops from the media bin. Mutations go back through `onChange`.
import { api } from "./api.js";

const HEAD_W = 110;
const fmt = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
};
export { fmt };

export class TimelineView {
  constructor({ scrollEl, innerEl, rulerEl, tracksEl, playheadEl, snaplineEl, getProject, getTime, onChange, onSelect, onSeek, onDrop, toast }) {
    Object.assign(this, { scrollEl, innerEl, rulerEl, tracksEl, playheadEl, snaplineEl, getProject, getTime, onChange, onSelect, onSeek, onDrop, toast });
    this.pps = 40; // px per second
    this.selected = null; // {trackId, clipId}
    this.bindGlobal();
  }

  get timeline() {
    return this.getProject().timeline;
  }

  duration() {
    let d = 0;
    for (const t of this.timeline.tracks) for (const c of t.clips) d = Math.max(d, c.start + c.duration);
    return d;
  }

  setZoom(pps) {
    this.pps = Math.max(2, Math.min(600, pps));
    this.render();
  }

  fit() {
    const d = Math.max(5, this.duration());
    const avail = this.scrollEl.clientWidth - HEAD_W - 40;
    this.setZoom(avail / d);
  }

  xOf(t) {
    return t * this.pps;
  }
  tOf(x) {
    return x / this.pps;
  }

  render() {
    const project = this.getProject();
    const mediaById = new Map(project.media.map((m) => [m.id, m]));
    const dur = this.duration();
    const totalW = Math.max(this.scrollEl.clientWidth, this.xOf(dur + 20) + HEAD_W);
    this.innerEl.style.width = `${totalW}px`;
    this.renderRuler(totalW - HEAD_W);
    this.tracksEl.innerHTML = "";
    for (const track of this.timeline.tracks) {
      const row = document.createElement("div");
      row.className = `track ${track.kind}`;
      row.dataset.track = track.id;
      const head = document.createElement("div");
      head.className = "head";
      head.innerHTML = `<span class="k">${track.kind}</span><span>${track.name}</span>`;
      const lane = document.createElement("div");
      lane.className = "lane";
      lane.dataset.track = track.id;
      for (const clip of track.clips) lane.appendChild(this.clipEl(track, clip, mediaById));
      this.bindLane(lane, track);
      row.append(head, lane);
      this.tracksEl.appendChild(row);
    }
    this.updatePlayhead(this.getTime());
  }

  renderRuler(width) {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((s) => s * this.pps >= 70) || 300;
    this.rulerEl.innerHTML = "";
    this.rulerEl.style.width = `${width}px`;
    for (let t = 0; t * this.pps < width; t += step) {
      const tick = document.createElement("div");
      tick.className = "tick";
      tick.style.left = `${this.xOf(t)}px`;
      tick.textContent = fmt(t).replace(/\.\d+$/, step < 1 ? (m) => m : "");
      this.rulerEl.appendChild(tick);
    }
    this.rulerEl.onpointerdown = (e) => {
      const seekFrom = (ev) => this.onSeek(Math.max(0, this.tOf(ev.clientX - this.rulerEl.getBoundingClientRect().left)));
      seekFrom(e);
      const move = (ev) => seekFrom(ev);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
  }

  clipEl(track, clip, mediaById) {
    const el = document.createElement("div");
    el.className = `clip ${track.kind}`;
    el.dataset.clip = clip.id;
    el.dataset.track = track.id;
    el.style.left = `${this.xOf(clip.start)}px`;
    el.style.width = `${Math.max(6, this.xOf(clip.duration))}px`;
    if (this.selected && this.selected.clipId === clip.id) el.classList.add("selected");
    let label = "";
    let sub = "";
    if (track.kind === "text") {
      label = clip.text.split("\n")[0];
      sub = clip.preset;
    } else {
      const m = mediaById.get(clip.mediaId);
      label = clip.label || m?.name || clip.mediaId;
      sub = `${fmt(clip.in)} ${clip.speed && clip.speed !== 1 ? `×${clip.speed}` : ""}${clip.muted ? " 🔇" : ""}`;
      if (m?.kind === "image") el.classList.add("image");
      if (m?.strip && track.kind === "video") {
        const h = 54; // clip inner height (track 64 - 2*4 - borders)
        const fw = Math.round(h * (16 / 9));
        el.style.backgroundImage = `url(${api.fileUrl(this.getProject().id, "thumbs", m.strip)})`;
        el.style.backgroundSize = `${m.stripFrames * fw}px ${h}px`;
        const srcPerPx = (clip.speed || 1) / this.pps; // source seconds per screen px
        // Pick the frame that matches the clip in-point, then let it repeat.
        const frameIdx = Math.min(m.stripFrames - 1, Math.floor(clip.in / m.stripInterval));
        el.style.backgroundPositionX = `${-frameIdx * fw}px`;
        // Stretch the strip so one frame ≈ stripInterval seconds on screen.
        const wantFrameW = m.stripInterval / srcPerPx;
        if (wantFrameW > 10) {
          el.style.backgroundSize = `${m.stripFrames * wantFrameW}px ${h}px`;
          el.style.backgroundPositionX = `${-(clip.in / m.stripInterval) * wantFrameW}px`;
        }
      }
    }
    el.innerHTML = `<div class="h l"></div><div class="h r"></div><div class="label"></div><div class="sub"></div>`;
    el.querySelector(".label").textContent = label;
    el.querySelector(".sub").textContent = sub;
    if (track.kind === "video" && clip.transitionIn?.type !== "cut") {
      const tr = document.createElement("div");
      tr.className = "tr";
      tr.title = `${clip.transitionIn.type} ${clip.transitionIn.duration}s`;
      el.appendChild(tr);
    }
    el.addEventListener("pointerdown", (e) => this.onClipPointerDown(e, track, clip, el));
    return el;
  }

  select(trackId, clipId) {
    this.selected = clipId ? { trackId, clipId } : null;
    for (const el of this.tracksEl.querySelectorAll(".clip")) el.classList.toggle("selected", el.dataset.clip === clipId);
    this.onSelect(this.selected);
  }

  snapPoints(exceptClipId) {
    const pts = [0, this.getTime()];
    for (const t of this.timeline.tracks) for (const c of t.clips) if (c.id !== exceptClipId) pts.push(c.start, c.start + c.duration);
    return pts;
  }

  snap(t, pts) {
    const thr = 8 / this.pps;
    let best = null;
    for (const p of pts) {
      const d = Math.abs(p - t);
      if (d < thr && (best === null || d < Math.abs(best - t))) best = p;
    }
    return best;
  }

  onClipPointerDown(e, track, clip, el) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.select(track.id, clip.id);
    const mode = e.target.classList.contains("h") ? (e.target.classList.contains("l") ? "trim-l" : "trim-r") : "move";
    const startX = e.clientX;
    const orig = { start: clip.start, duration: clip.duration, in: clip.in || 0 };
    const project = this.getProject();
    const media = project.media.find((m) => m.id === clip.mediaId);
    const speed = clip.speed || 1;
    const maxSrc = media && media.kind !== "image" && media.duration ? media.duration : Infinity;
    const pts = this.snapPoints(clip.id);
    let work = { ...orig };
    let moved = false;
    el.setPointerCapture(e.pointerId);

    const apply = () => {
      el.style.left = `${this.xOf(work.start)}px`;
      el.style.width = `${Math.max(6, this.xOf(work.duration))}px`;
    };
    const move = (ev) => {
      const dt = (ev.clientX - startX) / this.pps;
      if (Math.abs(ev.clientX - startX) > 2) moved = true;
      let snapped = null;
      if (mode === "move") {
        let s = Math.max(0, orig.start + dt);
        const a = this.snap(s, pts);
        const b = this.snap(s + orig.duration, pts);
        if (a !== null) { s = a; snapped = a; }
        else if (b !== null) { s = b - orig.duration; snapped = b; }
        work = { ...orig, start: Math.max(0, s) };
      } else if (mode === "trim-l") {
        let s = orig.start + dt;
        const a = this.snap(s, pts);
        if (a !== null) { s = a; snapped = a; }
        const minStart = orig.start - orig.in / speed; // can't reveal before source 0
        s = Math.max(0, Math.max(minStart, Math.min(s, orig.start + orig.duration - 0.1)));
        const delta = s - orig.start;
        work = { start: s, duration: orig.duration - delta, in: orig.in + delta * speed };
      } else {
        let end = orig.start + orig.duration + dt;
        const a = this.snap(end, pts);
        if (a !== null) { end = a; snapped = a; }
        const maxDur = maxSrc === Infinity ? Infinity : (maxSrc - orig.in) / speed;
        const d = Math.max(0.1, Math.min(end - orig.start, maxDur));
        work = { ...orig, duration: d };
      }
      work.start = round3(work.start);
      work.duration = round3(work.duration);
      work.in = round3(work.in);
      apply();
      if (snapped !== null) {
        this.snaplineEl.hidden = false;
        this.snaplineEl.style.left = `${this.xOf(snapped)}px`;
      } else this.snaplineEl.hidden = true;
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      this.snaplineEl.hidden = true;
      if (!moved) return;
      const overlaps = track.clips.some((c) => c.id !== clip.id && work.start < c.start + c.duration && work.start + work.duration > c.start);
      if (overlaps) {
        this.toast("Clips can't overlap on the same track", true);
        el.style.left = `${this.xOf(orig.start)}px`;
        el.style.width = `${Math.max(6, this.xOf(orig.duration))}px`;
        return;
      }
      this.onChange(mode === "move" ? "move clip" : "trim clip", (tl) => {
        const tr = tl.tracks.find((t) => t.id === track.id);
        const c = tr.clips.find((c) => c.id === clip.id);
        Object.assign(c, work);
        if (tr.kind === "video" && mode === "move") {
          // A moved clip no longer touches its predecessor → drop its transition.
          const prev = tr.clips.filter((x) => x.id !== c.id && x.start + x.duration <= c.start + 0.02).sort((a, b) => b.start - a.start)[0];
          if (!prev || Math.abs(prev.start + prev.duration - c.start) > 0.02) c.transitionIn = { type: "cut", duration: 0.5 };
        }
        tr.clips.sort((a, b) => a.start - b.start);
      });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  bindLane(lane, track) {
    lane.addEventListener("pointerdown", (e) => {
      if (e.target !== lane) return;
      this.select(null, null);
      const rect = lane.getBoundingClientRect();
      this.onSeek(Math.max(0, this.tOf(e.clientX - rect.left)));
    });
    lane.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/sonika-media")) return;
      e.preventDefault();
      lane.classList.add("drop");
    });
    lane.addEventListener("dragleave", () => lane.classList.remove("drop"));
    lane.addEventListener("drop", (e) => {
      e.preventDefault();
      lane.classList.remove("drop");
      const mediaId = e.dataTransfer.getData("text/sonika-media");
      if (!mediaId) return;
      const rect = lane.getBoundingClientRect();
      this.onDrop(mediaId, track.id, Math.max(0, this.tOf(e.clientX - rect.left)));
    });
  }

  updatePlayhead(t) {
    this.playheadEl.style.left = `${this.xOf(t)}px`;
  }

  /** Keep the playhead in view while playing. */
  follow(t) {
    const x = this.xOf(t) + HEAD_W;
    const left = this.scrollEl.scrollLeft;
    const w = this.scrollEl.clientWidth;
    if (x < left + HEAD_W || x > left + w - 40) this.scrollEl.scrollLeft = Math.max(0, x - w / 3);
  }

  bindGlobal() {
    window.addEventListener("resize", () => this.render());
  }
}

const round3 = (n) => Math.round(n * 1000) / 1000;
