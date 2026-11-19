import type { Recap } from './types';

type Scene = { recap: Recap; photos: { id: string; src: string }[]; width: number; height: number; snapshotHash: string };

function wrapped(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, width: number, line: number, max: number) {
  const words = value.split(/\s+/); let text = ''; let count = 0;
  for (const word of words) {
    const next = text ? `${text} ${word}` : word;
    if (ctx.measureText(next).width > width && text) {
      ctx.fillText(text, x, y + count++ * line); text = word;
      if (count === max) return;
    } else text = next;
  }
  if (text && count < max) ctx.fillText(text, x, y + count * line);
}
async function render(scene: Scene) {
  const canvas = document.createElement('canvas'); canvas.width = scene.width; canvas.height = scene.height;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas rendering is unavailable in this browser.');
  const { recap, photos } = scene;
  ctx.fillStyle = '#f4f0e7'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#496e6b'; ctx.font = '600 18px sans-serif'; ctx.fillText(recap.theme === 'data' ? 'PLACES & PHOTOS' : recap.theme === 'story' ? 'PHOTO STORY' : 'TRAVEL RECAP', 70, 65);
  ctx.fillStyle = '#283d3b'; ctx.font = 'bold 48px sans-serif'; wrapped(ctx, recap.title, 70, 125, 1260, 55, 2);
  ctx.fillStyle = '#596c68'; ctx.font = '22px sans-serif'; wrapped(ctx, recap.summary, 70, 230, 1260, 31, 3);
  const chosen = photos.slice(0, 6); const columns = Math.min(3, Math.max(1, chosen.length)); const rows = Math.ceil(chosen.length / columns);
  const gap = 14, gridY = 340, gridH = 400, gridW = 1260;
  const cellW = (gridW - gap * (columns - 1)) / columns, cellH = (gridH - gap * (rows - 1)) / Math.max(1, rows);
  const images = await Promise.all(chosen.map(p => new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('A saved photo could not be loaded for export.')); img.src = p.src; })));
  images.forEach((img, i) => { const x = 70 + (i % columns) * (cellW + gap), y = gridY + Math.floor(i / columns) * (cellH + gap); const scale = Math.max(cellW / img.naturalWidth, cellH / img.naturalHeight); const w = img.naturalWidth * scale, h = img.naturalHeight * scale; ctx.save(); ctx.beginPath(); ctx.rect(x, y, cellW, cellH); ctx.clip(); ctx.drawImage(img, x + (cellW - w) / 2, y + (cellH - h) / 2, w, h); ctx.restore(); });
  ctx.fillStyle = '#496e6b'; ctx.font = '18px sans-serif'; ctx.fillText(`${photos.length} photos${photos.length > chosen.length ? ` · showing ${chosen.length}` : ''}`, 70, 790);
  ctx.fillStyle = '#283d3b'; ctx.font = '18px sans-serif'; wrapped(ctx, recap.highlights.join('  ·  '), 70, 830, 1260, 26, 2);
  return canvas;
}
function save(blob: Blob, filename: string) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
export async function exportRecap(id: string, format: 'png' | 'mp4') {
  const response = await fetch(`/api/export/${encodeURIComponent(id)}?format=scene`);
  if (!response.ok) throw new Error('Could not load the saved recap for export.');
  const scene: Scene = await response.json(); const canvas = await render(scene);
  const name = `travel-recap-${scene.snapshotHash.slice(0, 12)}`;
  if (format === 'png') {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not create the PNG image.'); save(blob, `${name}.png`); return;
  }
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') throw new Error('MP4 export requires a browser with WebCodecs H.264 support. Try a recent Chrome or Edge.');
  const config: VideoEncoderConfig = { codec: 'avc1.420028', width: canvas.width, height: canvas.height, bitrate: 3_000_000, framerate: 30, avc: { format: 'avc' } };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('This browser cannot encode H.264 MP4. Try a recent Chrome or Edge.');
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const target = new ArrayBufferTarget(); const muxer = new Muxer({ target, video: { codec: 'avc', width: canvas.width, height: canvas.height }, fastStart: 'in-memory' });
  let failure: Error | null = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failure = e; } });
  try { encoder.configure(config); for (let i = 0; i < 90; i++) { const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1_000_000 / 30), duration: Math.round(1_000_000 / 30) }); encoder.encode(frame, { keyFrame: i === 0 }); frame.close(); if (encoder.encodeQueueSize > 10) await encoder.flush(); } await encoder.flush(); if (failure) throw failure; muxer.finalize(); save(new Blob([target.buffer], { type: 'video/mp4' }), `${name}.mp4`); } finally { encoder.close(); }
}
