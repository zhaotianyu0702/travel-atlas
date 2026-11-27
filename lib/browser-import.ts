import type { Photo } from './types';
import { parsePhotoTime } from './photo-time';

const BATCH_LIMIT = 24 * 1024 * 1024;
const TARGET_BYTES = 650 * 1024;
type ImportError = { fileName: string; error: string };
type Entry = { file: Blob; thumbnail: Blob; name: string; dimensions: { width: number; height: number }; source: { sha256: string } };
export type ImportProgress = { completed: number; prepared: number; total: number; phase: 'preparing' | 'uploading' };

async function decode(blob: Blob): Promise<ImageBitmap> {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (error) {
    if (!/hei[cf]/i.test(blob.type) && !(blob instanceof File && /\.hei[cf]$/i.test(blob.name))) throw error;
    const { heicTo } = await import('heic-to');
    try { return await heicTo({ blob, type: 'bitmap' }); }
    catch { /* Keep the proven JPEG route if this browser cannot build a bitmap directly. */ }
    return createImageBitmap(await heicTo({ blob, type: 'image/jpeg', quality: 0.9 }));
  }
}
async function jpeg(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image processing is unavailable in this browser.');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const result = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!result || result.type !== 'image/jpeg') throw new Error('Could not prepare JPEG image.');
    return result;
  } finally { canvas.width = 0; canvas.height = 0; }
}
async function prepare(file: File, keepOriginals: boolean, sourceBuffer: ArrayBuffer, hash: string): Promise<Entry> {
  let bitmap: ImageBitmap | undefined;
  try {
    try { bitmap = await decode(file); } catch { throw new Error('Could not decode this image.'); }
    const thumbnail = await jpeg(bitmap, 800, 0.69);
    const { default: exifr } = await import('exifr');
    let raw: Record<string, unknown> = {};
    try { raw = await exifr.parse(sourceBuffer, { gps: true, exif: true, tiff: true, reviveValues: false }) || {}; } catch { /* optional metadata */ }
    const time = parsePhotoTime(raw);
    const hasGps = typeof raw.latitude === 'number' && Number.isFinite(raw.latitude) && Math.abs(raw.latitude) <= 90 && typeof raw.longitude === 'number' && Number.isFinite(raw.longitude) && Math.abs(raw.longitude) <= 180;
    const source = { sha256: hash, mode: keepOriginals ? 'original' : 'optimized', time, latitude: hasGps ? raw.latitude : null, longitude: hasGps ? raw.longitude : null };
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
export async function importPhotos(files: File[], tripId: string, options: { keepOriginals?: boolean; knownSourceHashes?: Iterable<string>; onUncertainWrite?: (hash: string) => void; onProgress?: (progress: ImportProgress) => void } = {}): Promise<{ imported: Photo[]; duplicates: number; errors: ImportError[] }> {
  const result: { imported: Photo[]; duplicates: number; errors: ImportError[] } = { imported: [], duplicates: 0, errors: [] };
  let batch: Entry[] = [], bytes = 0, completed = 0, prepared = 0;
  let upload: Promise<void> | undefined;
  let firstBatch = true;
  const candidates = new Set(options.knownSourceHashes ?? []), confirmed = new Set<string>();
  let verified: Promise<Set<string> | null> | undefined;
  let uploadingHashes = new Set<string>();
  // The workspace hint can be stale; verify against the server, including trash,
  // once and only when a hint matches. A failed check falls back to upload.
  const verify = () => verified ??= (async () => {
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/photo-hashes`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return null;
      const payload = await response.json() as { hashes?: unknown };
      if (!Array.isArray(payload.hashes) || !payload.hashes.every(h => typeof h === 'string')) return null;
      return new Set(payload.hashes as string[]);
    } catch { return null; }
  })();
  const report = (phase: ImportProgress['phase']) => options.onProgress?.({ completed, prepared, total: files.length, phase });
  const send = async (entries: Entry[]) => {
    report('uploading');
    const sendBatch = async (current: Entry[]): Promise<void> => {
      const body = new FormData(); body.append('tripId', tripId);
      for (const e of current) { body.append('files', e.file, e.name); body.append('thumbnails', e.thumbnail, `${e.name}.jpg`); }
      body.append('dimensions', JSON.stringify(current.map(e => e.dimensions)));
      body.append('sources', JSON.stringify(current.map(e => e.source)));
      let failure = 'Upload failed.';
      for (let attempt=0; attempt<3; attempt++) {
        let retry = false;
        try {
          const response = await fetch('/api/photos', { method: 'POST', body, signal: AbortSignal.timeout(45_000) });
          // An explicit size rejection is the only reason to split a batch.
          if (response.status===413 && current.length>1) {
            const middle=Math.floor(current.length/2);
            await sendBatch(current.slice(0,middle));
            await sendBatch(current.slice(middle));
            return;
          }
          if (!response.ok) {
            let message = '';
            try { const payload=await response.json() as {error?:unknown}; if(typeof payload.error==='string')message=payload.error; } catch { /* proxy may return non-JSON */ }
            failure=message||`Upload failed (HTTP ${response.status}).`;
            retry=[408,425,429,500,502,503,504].includes(response.status);
          } else {
            // If a successful response is lost or unreadable, retrying the same
            // source hashes lets the server report already-saved photos as duplicates.
            const payload = await response.json() as { imported?: Photo[]; duplicates?: number; errors?: ImportError[] };
            if (!Array.isArray(payload.imported)||!Array.isArray(payload.errors)||typeof payload.duplicates!=='number'||!Number.isInteger(payload.duplicates)||payload.duplicates<0||payload.imported.length+payload.errors.length+payload.duplicates!==current.length) throw new Error('Upload response was incomplete.');
            for (const photo of payload.imported || []) if (typeof photo.sha256 === 'string') confirmed.add(photo.sha256);
            result.imported.push(...(payload.imported || [])); result.duplicates += payload.duplicates || 0; result.errors.push(...(payload.errors || []));
            completed += current.length; report('uploading');
            return;
          }
        } catch (error) {
          failure=error instanceof Error ? error.message : 'Upload failed.';
          retry=true;
        }
        if (retry) for (const entry of current) options.onUncertainWrite?.(entry.source.sha256);
        if(!retry||attempt===2)break;
        await new Promise(resolve=>setTimeout(resolve,200*2**attempt));
      }
      for (const e of current) result.errors.push({fileName:e.name,error:failure});
      completed += current.length; report('uploading');
    };
    await sendBatch(entries);
  };
  const flush = async () => {
    if (!batch.length) return;
    // Serialize uploads for deterministic duplicate handling, while preparation continues.
    await upload;
    const current = batch; batch = []; bytes = 0;
    firstBatch = false;
    uploadingHashes = new Set(current.map(e => e.source.sha256));
    upload = send(current).finally(() => { uploadingHashes = new Set(); });
  };
  // Two decodes at most; consume in selection order even if the second finishes first.
  type Prepared = { entry: Entry } | { duplicate: true } | { error: unknown };
  const processFile = async (file: File): Promise<Prepared> => {
    try {
      const keepOriginals = !!options.keepOriginals, maxSourceMiB = keepOriginals ? 24 : 64;
      if (!file.size || file.size > maxSourceMiB * 1024 * 1024) throw new Error(`File must be between 1 byte and ${maxSourceMiB} MiB.`);
      const buffer = await file.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), b => b.toString(16).padStart(2, '0')).join('');
      if (confirmed.has(hash)) return { duplicate: true };
      if (candidates.has(hash) && (await verify())?.has(hash)) return { duplicate: true };
      // If this exact source is being uploaded, wait for its result. A failure
      // must leave this copy eligible for a fresh attempt.
      if (uploadingHashes.has(hash)) { await upload; if (confirmed.has(hash)) return { duplicate: true }; }
      return { entry: await prepare(file, keepOriginals, buffer, hash) };
    } catch (error) { return { error }; }
  };
  const pending: Promise<Prepared>[] = [];
  let next = 0;
  const start = () => {
    while (next < files.length && pending.length < 2) {
      const file = files[next++];
      pending.push(processFile(file));
    }
  };
  report('preparing');
  start();
  for (const file of files) {
    const outcome = await pending.shift()!;
    start();
    if ('entry' in outcome) {
      const entry = outcome.entry, size = entry.file.size + entry.thumbnail.size;
      if (bytes + size > BATCH_LIMIT || batch.length >= 20) await flush();
      batch.push(entry); bytes += size;
      // Start a small first request promptly; later requests remain efficiently batched.
      if (firstBatch && batch.length >= 2) await flush();
    } else if ('duplicate' in outcome) {
      result.duplicates++; completed++;
    } else {
      result.errors.push({ fileName: file.name, error: outcome.error instanceof Error ? outcome.error.message : 'Could not prepare the image.' });
      completed++;
    }
    prepared++;
    report('preparing');
  }
  await flush();
  await upload;
  return result;
}
