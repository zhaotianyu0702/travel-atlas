import { recapFrameCopy, type RecapScene, type RecapScenePhoto } from "./recap-story";
import { buildRecapSceneMap, drawRecapMapBase, drawRecapMapRoute, type RecapMap } from "./recap-map";

const W = 1920,
  H = 1080,
  FPS = 30,
  PHOTO_SECONDS = 3,
  BOOKEND_SECONDS = 2;
// Keeps encoding time and the in-memory MP4 bounded, without dropping selected photos.
const MAX_VIDEO_PHOTOS = 60;
// Use the same inset slot for every scene and both bookends.
const MAP_WIDTH = 480;
const MAP_HEIGHT = 245;
const MAP_RIGHT = 96;
const MAP_BOTTOM = 70;

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function loadPhoto(photo: RecapScenePhoto): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = setTimeout(() => { image.src = ""; reject(new Error("Photo loading timed out. Check your connection and retry.")); }, 30_000);
    image.onload = () => {
      clearTimeout(timeout);
      image.naturalWidth && image.naturalHeight
        ? resolve(image)
        : reject(
            new Error(
              `Could not load photo ${photo.label || photo.id} for export.`,
            ),
          );
    };
    image.onerror = () => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Could not load photo ${photo.label || photo.id} for export.`,
        ),
      );
    };
    image.src = photo.src;
  });
}
function ease(t: number) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}
function photoCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  progress: number,
  index: number,
  motion = 1,
) {
  const backgroundScale = Math.max(
    W / image.naturalWidth,
    H / image.naturalHeight,
  );
  const backgroundWidth = image.naturalWidth * backgroundScale;
  const backgroundHeight = image.naturalHeight * backgroundScale;
  ctx.drawImage(
    image,
    (W - backgroundWidth) / 2,
    (H - backgroundHeight) / 2,
    backgroundWidth,
    backgroundHeight,
  );
  ctx.fillStyle = "rgba(12,31,29,.72)";
  ctx.fillRect(0, 0, W, H);
  const scale =
    Math.min(W / image.naturalWidth, H / image.naturalHeight) *
    (1 + 0.025 * motion * ease(progress));
  const w = image.naturalWidth * scale,
    h = image.naturalHeight * scale;
  const pan = (ease(progress) - 0.5) * (index % 2 ? -1 : 1);
  ctx.drawImage(image, (W - w) / 2 + pan * 12 * motion, (H - h) / 2, w, h);
}
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length && ctx.measureText(`${result}…`).width > maxWidth)
    result = result.slice(0, -1);
  return `${result.trimEnd()}…`;
}
function route(ctx: CanvasRenderingContext2D, map: RecapMap, base: HTMLCanvasElement | null, progress: number) {
  if (!base) return;
  const x = W - MAP_RIGHT - MAP_WIDTH, y = H - MAP_BOTTOM - MAP_HEIGHT;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x, y, map.width, map.height, 18); ctx.clip();
  ctx.drawImage(base, x, y);
  ctx.translate(x, y);
  drawRecapMapRoute(ctx, map, progress);
  ctx.restore();
  ctx.save(); ctx.strokeStyle = "rgba(255,250,240,.9)"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.roundRect(x, y, map.width, map.height, 18); ctx.stroke(); ctx.restore();
}

function titleLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  // Break long unspaced text as well as ordinary words, without splitting surrogate pairs.
  const lines: string[] = [];
  let line = "";
  for (const char of Array.from(text.trim())) {
    if (char === "\n") { if (line.trim()) lines.push(line.trim()); line = ""; continue; }
    if (line && ctx.measureText(line + char).width > maxWidth) {
      const breakAt = line.lastIndexOf(" ");
      if (breakAt > 0) { lines.push(line.slice(0, breakAt)); line = line.slice(breakAt + 1) + char; }
      else { lines.push(line); line = char; }
    } else line += char;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
function limitedLines(ctx: CanvasRenderingContext2D, text: string, width: number, limit: number): string[] {
  const lines = titleLines(ctx, text, width);
  if (lines.length <= limit) return lines;
  const result = lines.slice(0, limit);
  result[limit - 1] = fitText(ctx, result[limit - 1] + "…", width);
  return result;
}

function overlay(
  ctx: CanvasRenderingContext2D,
  scene: RecapScene,
  index: number,
  routeProgress: number,
  _title: boolean,
  map: RecapMap,
  mapBase: HTMLCanvasElement | null,
) {
  const gradient = ctx.createLinearGradient(0, 0, 0, H * 0.48);
  gradient.addColorStop(0, "rgba(12,31,29,.82)");
  gradient.addColorStop(1, "rgba(12,31,29,0)");
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, W, H);
  drawFrameCopy(ctx, recapFrameCopy(scene, index), 72);

  route(ctx, map, mapBase, routeProgress);
}
function makeCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas rendering is unavailable in this browser.");
  return { canvas, ctx };
}
const yieldToUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type CutBeat = { photoIds: string[]; caption: string; seconds: number };

/** Render a photo in a crop-safe cell. Portraits keep their full frame over a photo-derived backdrop. */
function photoCell(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number, cover: boolean, zoom = 1) {
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
  const draw = (scale: number) => {
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
  };
  const portrait = image.naturalWidth / image.naturalHeight < .67;
  if (portrait && cover) {
    ctx.save(); ctx.filter = "blur(28px) brightness(.66)";
    draw(Math.max(width / image.naturalWidth, height / image.naturalHeight) * 1.08);
    ctx.restore();
  }
  const scale = (cover && !portrait ? Math.max : Math.min)(width / image.naturalWidth, height / image.naturalHeight);
  draw(scale * (portrait ? 1 : zoom));
  ctx.restore();
}
/** Each guided preset uses its own photographic layout. */
function cutComposition(ctx: CanvasRenderingContext2D, images: HTMLImageElement[], progress: number, index: number, style?: "minimal" | "cinematic" | "dynamic") {
  if (!style) {
    ctx.fillStyle = "#172d2c"; ctx.fillRect(0, 0, W, H);
    if (images.length < 2) { photoCover(ctx, images[0], progress, index); return; }
    const gap = 14, margin = 36, width = (W - margin * 2 - gap) / 2;
    images.slice(0, 2).forEach((image, i) => photoCell(ctx, image, margin + i * (width + gap), margin, width, H - margin * 2, false));
    return;
  }
  ctx.save();
  ctx.fillStyle = style === "minimal" ? "#f3ede1" : style === "dynamic" ? "#38232b" : "#241e21"; ctx.fillRect(0, 0, W, H);
  ctx.filter = style === "cinematic" ? "saturate(.95) contrast(1.12)" : style === "dynamic" ? "saturate(1.16) contrast(1.08)" : "none";
  const margin = style === "minimal" ? 64 : 0;
  const y = style === "minimal" ? 280 : 0;
  const height = H - y - margin;
  const gap = style === "minimal" ? 16 : style === "dynamic" ? 8 : 4;
  const available = W - 2 * margin;
  const zoom = style === "cinematic" ? 1 + .035 * ease(progress) : style === "dynamic" ? 1 + .065 * ease(progress) : 1;
  if (images.length === 1) photoCell(ctx, images[0], margin, y, available, height, style !== "minimal", zoom);
  else {
    const left = (available - gap) * (style === "dynamic" ? .65 : .5);
    photoCell(ctx, images[0], margin, y, left, height, style !== "minimal", zoom);
    photoCell(ctx, images[1], margin + left + gap, y, available - gap - left, height, style !== "minimal", zoom);
  }
  ctx.restore();
}

/** One moment keeps the entire photograph within a quiet, dark frame. */
function focusComposition(ctx: CanvasRenderingContext2D, image: HTMLImageElement, style?: "minimal" | "cinematic" | "dynamic") {
  ctx.save();
  ctx.filter = style === "cinematic" ? "saturate(.85) contrast(1.08)" : style === "dynamic" ? "saturate(1.18) contrast(1.06)" : "none";
  ctx.fillStyle = "#172d2c"; ctx.fillRect(0, 0, W, H);
  const x = 96, y = 64, width = W - 192, height = 790;
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
  ctx.restore();
}
function drawFrameCopy(ctx: CanvasRenderingContext2D, copy: { headline: string; date: string; place: string }, size: number, dark = false) {
  ctx.fillStyle = dark ? "#263d39" : "#f4f0e7";
  ctx.font = `600 ${size}px Georgia, serif`;
  const lines = limitedLines(ctx, copy.headline, 1190, 2);
  lines.forEach((line, i) => ctx.fillText(line, 110, 150 + i * size * 1.18));
  const details = [copy.date, copy.place].filter(Boolean).join("  ·  ");
  if (details) {
    ctx.font = "30px sans-serif";
    limitedLines(ctx, details, 1190, 2).forEach((line, i) => ctx.fillText(line, 110, 150 + lines.length * size * 1.18 + i * 32));
  }
}
function cutOverlay(ctx: CanvasRenderingContext2D, scene: RecapScene, beat: CutBeat, opening: boolean, routeProgress: number, map: RecapMap, mapBase: HTMLCanvasElement | null, photoIndex: number) {
  const presentation = scene.recap.cut?.presentation;
  const copy = recapFrameCopy(scene, photoIndex, beat, opening);
  if (copy.headline || copy.date || copy.place) {
    const gradient = ctx.createLinearGradient(0, 0, 0, H * .48);
    gradient.addColorStop(0, presentation?.style === "minimal" ? "rgba(243,237,225,0)" : "rgba(12,31,29,.88)");
    gradient.addColorStop(1, "rgba(12,31,29,0)");
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, W, H);
    drawFrameCopy(ctx, copy, presentation ? 88 : opening ? 72 : 60, presentation?.style === "minimal");
  }
  route(ctx, map, mapBase, routeProgress);
}

async function exportCut(scene: RecapScene, format: "png" | "mp4", name: string, onProgress?: (progress: number) => void, musicId?: string) {
  const { canvas, ctx } = makeCanvas();
  const byId = new Map(scene.photos.map(p => [p.id, p]));
  const beats = scene.beats.map(beat => ({ ...beat, photos: beat.photoIds.flatMap(id => { const p = byId.get(id); return p ? [p] : []; }).slice(0, 2) })).filter(beat => beat.photos.length);
  if (!beats.length) throw new Error("No photos are available in this recap cut.");
  const focus = scene.recap.cut?.kind === "focus";
  const map = buildRecapSceneMap(scene, MAP_WIDTH, MAP_HEIGHT);
  let mapBase: HTMLCanvasElement | null = null;
  {
    mapBase = document.createElement("canvas"); mapBase.width = map.width; mapBase.height = map.height;
    const mapContext = mapBase.getContext("2d");
    if (!mapContext) throw new Error("Canvas rendering is unavailable in this browser.");
    drawRecapMapBase(mapContext, scene.recap.cut?.presentation ? { ...map, labels: [] } : map);
  }
  const durations = beats.map(b => Number.isFinite(b.seconds) ? Math.max(0.25, b.seconds) : PHOTO_SECONDS);
  const loadBeat = (i: number) => Promise.all(beats[i].photos.map(loadPhoto));
  let current = await loadBeat(0);
  if (format === "png") {
    if (focus && !scene.recap.cut?.presentation) focusComposition(ctx, current[0]);
    else cutComposition(ctx, current, 0.35, 0, scene.recap.cut?.presentation?.style);
    cutOverlay(ctx, scene, beats[0], true, scene.photos.indexOf(beats[0].photos[0]), map, mapBase, scene.photos.indexOf(beats[0].photos[0]));
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not create the PNG image.");
    save(blob, `${name}.png`); onProgress?.(1); return;
  }
  const { getSoundtrack, loadSoundtrack, encodeSoundtrack, soundtrackTimeline, SOUNDTRACK_SAMPLE_RATE, SOUNDTRACK_CHANNELS } = await import("./recap-soundtrack");
  const track = getSoundtrack(musicId);
  const soundtrack = await loadSoundtrack(track);
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: "avc", width: W, height: H }, audio: { codec: "aac", sampleRate: SOUNDTRACK_SAMPLE_RATE, numberOfChannels: SOUNDTRACK_CHANNELS }, firstTimestampBehavior: "offset", fastStart: "in-memory" });
  let failure: Error | null = null;
  const encoder = new VideoEncoder({ output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata), error: error => { failure = error; } });
  const timeline = soundtrackTimeline(durations, FPS, BOOKEND_SECONDS, track);
  const totalFrames = timeline.totalFrames;
  try {
    encoder.configure({ codec: "avc1.64002a", width: W, height: H, bitrate: 8_000_000, framerate: FPS, avc: { format: "avc" } });
    let loadedIndex = 0, next: HTMLImageElement[] | null = null;
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      if (failure) throw failure;
      const storyFrame = Math.max(timeline.first, frameIndex);
      let index = beats.length - 1;
      for (let i = 0; i < beats.length; i++) if (storyFrame < timeline.starts[i] + timeline.durations[i]) { index = i; break; }
      if (index !== loadedIndex) { current = next || await loadBeat(index); next = null; loadedIndex = index; }
      const within = Math.max(0, Math.min(1, (storyFrame - timeline.starts[index]) / timeline.durations[index]));
      const transition = index < beats.length - 1 && frameIndex >= timeline.first ? ease((within - .8) / .2) : 0;
      if (transition > 0 && !next) next = await loadBeat(index + 1);
      if (focus && !scene.recap.cut?.presentation) focusComposition(ctx, current[0]); else cutComposition(ctx, current, within, index, scene.recap.cut?.presentation?.style);
      if (next && transition > 0) { ctx.save(); if (scene.recap.cut?.presentation?.style === "dynamic") { ctx.beginPath(); ctx.rect(W * (1 - transition), 0, W * transition, H); ctx.clip(); } else ctx.globalAlpha = transition; if (focus && !scene.recap.cut?.presentation) focusComposition(ctx, next[0]); else cutComposition(ctx, next, 0, index + 1, scene.recap.cut?.presentation?.style); ctx.restore(); }
      const photoIndex = scene.photos.indexOf(beats[index].photos[0]);
      const nextPhotoIndex = index + 1 < beats.length ? scene.photos.indexOf(beats[index + 1].photos[0]) : photoIndex;
      const routeProgress = nextPhotoIndex === photoIndex + 1 ? photoIndex + transition : photoIndex;
      cutOverlay(ctx, scene, beats[index], index === 0, routeProgress, map, mapBase, photoIndex);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(frameIndex * 1_000_000 / FPS), duration: Math.round(1_000_000 / FPS) });
      try { encoder.encode(frame, { keyFrame: frameIndex % (FPS * 2) === 0 }); } finally { frame.close(); }
      if (encoder.encodeQueueSize > 8) await encoder.flush();
      if (frameIndex % 15 === 0) { onProgress?.(frameIndex / totalFrames * .9); await yieldToUI(); }
    }
    await encoder.flush(); if (failure) throw failure; await encodeSoundtrack(soundtrack, muxer, totalFrames / FPS, track); muxer.finalize();
    save(new Blob([target.buffer], { type: "video/mp4" }), `${name}-${track.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.mp4`); onProgress?.(1);
  } finally { encoder.close(); }
}


export async function exportRecap(
  id: string,
  format: "png" | "mp4",
  onProgress?: (progress: number) => void,
  musicId?: string,
): Promise<void> {
  onProgress?.(0);
  const config: VideoEncoderConfig = {
    codec: "avc1.64002a", width: W, height: H, bitrate: 8_000_000,
    framerate: FPS, avc: { format: "avc" },
  };
  if (format === "mp4") {
    if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined")
      throw new Error("MP4 export requires a browser with WebCodecs H.264 support. Try a recent Chrome or Edge.");
    if (!(await VideoEncoder.isConfigSupported(config)).supported)
      throw new Error("This browser cannot encode 1080p H.264 MP4. Try a recent Chrome or Edge.");
  }
  const response = await fetch(
    `/api/export/${encodeURIComponent(id)}?format=scene`,
  );
  if (!response.ok)
    throw new Error("Could not load the saved recap for export.");
  const scene: RecapScene = await response.json();
  if (!scene.photos.length)
    throw new Error("Add at least one photo to this recap before exporting.");
  if (format === "mp4" && scene.photos.length > MAX_VIDEO_PHOTOS)
    throw new Error(
      `Video export supports up to ${MAX_VIDEO_PHOTOS} photos. Reduce the selection and try again.`,
    );
  const name = `travel-recap-${scene.snapshotHash.slice(0, 12)}`;
  if (scene.beats?.length && scene.recap.cut) return exportCut(scene, format, name, onProgress, musicId);
  const { canvas, ctx } = makeCanvas();
  const map = buildRecapSceneMap(scene, MAP_WIDTH, MAP_HEIGHT);
  let mapBase: HTMLCanvasElement | null = null;
  {
    mapBase = document.createElement("canvas"); mapBase.width = map.width; mapBase.height = map.height;
    const mapContext = mapBase.getContext("2d");
    if (!mapContext) throw new Error("Canvas rendering is unavailable in this browser.");
    drawRecapMapBase(mapContext, map);
  }
  let current = await loadPhoto(scene.photos[0]);
  if (format === "png") {
    photoCover(ctx, current, 0.35, 0);
    overlay(ctx, scene, 0, 0, true, map, mapBase);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("Could not create the PNG image.");
    save(blob, `${name}.png`);
    onProgress?.(1);
    return;
  }
  const { getSoundtrack, loadSoundtrack, encodeSoundtrack, soundtrackTimeline, SOUNDTRACK_SAMPLE_RATE, SOUNDTRACK_CHANNELS } = await import("./recap-soundtrack");
  const track = getSoundtrack(musicId);
  const soundtrack = await loadSoundtrack(track);
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: W, height: H },
    audio: { codec: "aac", sampleRate: SOUNDTRACK_SAMPLE_RATE, numberOfChannels: SOUNDTRACK_CHANNELS },
    firstTimestampBehavior: "offset",
    fastStart: "in-memory",
  });
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => {
      failure = error;
    },
  });
  const timeline = soundtrackTimeline(scene.photos.map(() => PHOTO_SECONDS), FPS, BOOKEND_SECONDS, track);
  const totalFrames = timeline.totalFrames;
  try {
    encoder.configure(config);
    let loadedIndex = 0;
    let next: HTMLImageElement | null = null;
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      if (failure) throw failure;
      const storyFrame = Math.max(timeline.first, frameIndex);
      let index = scene.photos.length - 1;
      for (let i = 0; i < scene.photos.length; i++) {
        if (storyFrame < timeline.starts[i] + timeline.durations[i]) { index = i; break; }
      }
      if (index !== loadedIndex) {
        current = next || (await loadPhoto(scene.photos[index]));
        next = null;
        loadedIndex = index;
      }
      const within = Math.min(
        1,
        (storyFrame - timeline.starts[index]) / timeline.durations[index],
      );
      const transition =
        index < scene.photos.length - 1 && frameIndex >= timeline.first
          ? ease((within - 0.78) / 0.22)
          : 0;
      if (transition > 0 && !next)
        next = await loadPhoto(scene.photos[index + 1]);
      photoCover(ctx, current, within, index);
      if (next && transition > 0) {
        ctx.save();
        ctx.globalAlpha = transition;
        photoCover(ctx, next, 0, index + 1);
        ctx.restore();
      }
      overlay(
        ctx,
        scene,
        index,
        Math.min(scene.photos.length - 1, index + transition),
        frameIndex < timeline.first || frameIndex >= totalFrames - Math.round(BOOKEND_SECONDS * FPS),
        map,
        mapBase,
      );
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((frameIndex * 1_000_000) / FPS),
        duration: Math.round(1_000_000 / FPS),
      });
      try {
        encoder.encode(frame, { keyFrame: frameIndex % (FPS * 2) === 0 });
      } finally {
        frame.close();
      }
      if (encoder.encodeQueueSize > 8) await encoder.flush();
      if (frameIndex % 15 === 0) {
        onProgress?.((frameIndex / totalFrames) * 0.9);
        await yieldToUI();
      }
    }
    await encoder.flush();
    if (failure) throw failure;
    await encodeSoundtrack(soundtrack, muxer, totalFrames / FPS, track);
    muxer.finalize();
    save(new Blob([target.buffer], { type: "video/mp4" }), `${name}-${track.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.mp4`);
    onProgress?.(1);
  } finally {
    encoder.close();
  }
}
