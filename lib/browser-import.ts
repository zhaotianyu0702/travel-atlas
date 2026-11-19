import type { Photo } from './types';
import { parsePhotoTime } from './photo-time';

const BATCH_LIMIT = 24 * 1024 * 1024;
const TARGET_BYTES = 650 * 1024;
type ImportError = { fileName: string; error: string };
type Entry = { file: Blob; thumbnail: Blob; name: string; dimensions: { width: number; height: number }; source: object };
export type ImportProgress = { completed: number; prepared: number; total: number; phase: 'preparing' | 'uploading' };

async function decode(blob: Blob): Promise<ImageBitmap> {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (error) {
    if (!/hei[cf]/i.test(blob.type) && !(blob instanceof File && /\.hei[cf]$/i.test(blob.name))) throw error;
    const { heicTo } = await import('heic-to');
    return createImageBitmap(await heicTo({ blob, type: 'image/jpeg', quality: 0.9 }));
  }
}
async function jpeg(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image processing is unavailable in this browser.');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const result = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!result || result.type !== 'image/jpeg') throw new Error('Could not prepare JPEG image.');
  return result;
}
async function prepare(file: File, keepOriginals: boolean): Promise<Entry> {
  const maxSourceMiB=keepOriginals?24:64;
  if (!file.size || file.size > maxSourceMiB * 1024 * 1024) throw new Error(`File must be between 1 byte and ${maxSourceMiB} MiB.`);
  let bitmap: ImageBitmap | undefined;
  try {
    try { bitmap = await decode(file); } catch { throw new Error('Could not decode this image.'); }
    const [sourceBuffer, thumbnail] = await Promise.all([file.arrayBuffer(), jpeg(bitmap, 800, 0.69)]);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', sourceBuffer)), b => b.toString(16).padStart(2, '0')).join('');
    const { default: exifr } = await import('exifr');
    let raw: Record<string, unknown> = {}, parsed: Record<string, unknown> = {};
    try { raw = await exifr.parse(sourceBuffer, { gps: true, exif: true, tiff: true, reviveValues: false }) || {}; } catch { /* optional metadata */ }
    try { parsed = await exifr.parse(sourceBuffer, { gps: true, exif: true, tiff: true }) || {}; } catch { /* optional metadata */ }
    const time = parsePhotoTime(raw);
    const hasGps = typeof parsed.latitude === 'number' && Number.isFinite(parsed.latitude) && Math.abs(parsed.latitude) <= 90 && typeof parsed.longitude === 'number' && Number.isFinite(parsed.longitude) && Math.abs(parsed.longitude) <= 180;
    const source = { sha256: hash, mode: keepOriginals ? 'original' : 'optimized', time, latitude: hasGps ? parsed.latitude : null, longitude: hasGps ? parsed.longitude : null };
    let archive: Blob = file;
    if (!keepOriginals) {
      // Always re-encode: this strips opaque metadata and makes download format predictable.
      archive = await jpeg(bitmap, 1920, 0.72);
      if (archive.size > TARGET_BYTES) archive = await jpeg(bitmap, 1920, 0.60);
      if (archive.size > TARGET_BYTES) archive = await jpeg(bitmap, 1600, 0.60);
      if (archive.size > TARGET_BYTES) archive = await jpeg(bitmap, 1280, 0.55);
    }
    if (archive.size + thumbnail.size > BATCH_LIMIT) throw new Error('Image and preview exceed the upload batch limit. Try optimized storage.');
    return { file: archive, thumbnail, name: file.name, dimensions: { width: bitmap.width, height: bitmap.height }, source };
  } finally { bitmap?.close(); }
}

/** Process incrementally so a large selection never builds one unbounded request. */
export async function importPhotos(files: File[], tripId: string, options: { keepOriginals?: boolean; onProgress?: (progress: ImportProgress) => void } = {}): Promise<{ imported: Photo[]; duplicates: number; errors: ImportError[] }> {
  const result: { imported: Photo[]; duplicates: number; errors: ImportError[] } = { imported: [], duplicates: 0, errors: [] };
  let batch: Entry[] = [], bytes = 0, completed = 0, prepared = 0;
  const report = (phase: ImportProgress['phase']) => options.onProgress?.({ completed, prepared, total: files.length, phase });
  const flush = async () => {
    if (!batch.length) return;
    report('uploading');
    const current = batch; batch = []; bytes = 0;
    const body = new FormData(); body.append('tripId', tripId);
    for (const e of current) { body.append('files', e.file, e.name); body.append('thumbnails', e.thumbnail, `${e.name}.jpg`); }
    body.append('dimensions', JSON.stringify(current.map(e => e.dimensions)));
    body.append('sources', JSON.stringify(current.map(e => e.source)));
    try {
      const response = await fetch('/api/photos', { method: 'POST', body, signal: AbortSignal.timeout(45_000) });
      const payload = await response.json() as { imported?: Photo[]; duplicates?: number; errors?: ImportError[]; error?: string };
      if (!response.ok) throw new Error(payload.error || 'Upload failed.');
      result.imported.push(...(payload.imported || [])); result.duplicates += payload.duplicates || 0; result.errors.push(...(payload.errors || []));
    } catch (error) { for (const e of current) result.errors.push({ fileName: e.name, error: error instanceof Error ? error.message : 'Upload failed.' }); }
    completed += current.length;
    report('uploading');
  };
  report('preparing');
  for (const file of files) {
    try {
      const entry = await prepare(file, !!options.keepOriginals), size = entry.file.size + entry.thumbnail.size;
      if (bytes + size > BATCH_LIMIT || batch.length >= 20) await flush();
      batch.push(entry); bytes += size;
    } catch (error) {
      result.errors.push({ fileName: file.name, error: error instanceof Error ? error.message : 'Could not prepare the image.' });
      completed++;
    }
    prepared++;
    report('preparing');
  }
  await flush(); return result;
}
