import exifr from 'exifr';
import { mutateStore, storage } from './cloud-store';
import { parsePhotoTime, type PhotoTimeResult } from './photo-time';
import type { Photo } from './types';

const MAX_FILE = 25 * 1024 * 1024, MAX_THUMB = 2 * 1024 * 1024;
function imageType(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [137,80,78,71,13,10,26,10].every((x,i)=>b[i]===x)) return 'image/png';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && String.fromCharCode(...b.slice(4,8)) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(String.fromCharCode(...b.slice(8,12)))) return 'image/heic';
  return null;
}
function thumbnailDimensions(bytes: Uint8Array, type: string): {width:number; height:number} {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(type==='image/png') {
    if(bytes.length<24 || String.fromCharCode(...bytes.slice(12,16))!=='IHDR') throw new Error('Invalid thumbnail');
    return {width:view.getUint32(16),height:view.getUint32(20)};
  }
  let i=2;
  while(i+4<=bytes.length) {
    if(bytes[i++]!==0xff) throw new Error('Invalid thumbnail');
    while(i<bytes.length&&bytes[i]===0xff)i++;
    const marker=bytes[i++];
    if(marker===0xd9||marker===0xda) break;
    if(marker===0x01||(marker>=0xd0&&marker<=0xd7)) continue;
    if(i+2>bytes.length) break;
    const len=view.getUint16(i); if(len<2||i+len>bytes.length) break;
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if(len<7) break; return {height:view.getUint16(i+3),width:view.getUint16(i+5)};
    }
    i+=len;
  }
  throw new Error('Invalid thumbnail');
}
function dimensions(input: unknown): { width:number; height:number } {
  if (!input || typeof input !== 'object') throw new Error('Missing image dimensions');
  const {width,height}=input as Record<string,unknown>;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 50000 || height > 50000 || width * height > 100_000_000) throw new Error('Invalid image dimensions');
  return {width,height};
}
function sourceMetadata(input: unknown): { sha256: string; mode: 'optimized' | 'original'; time: PhotoTimeResult; latitude: number | null; longitude: number | null } | null {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid source metadata');
  const source=input as Record<string,unknown>, time=source.time as Record<string,unknown> | null;
  if (typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256) || !['optimized','original'].includes(String(source.mode)) || !time || typeof time !== 'object' || Array.isArray(time)) throw new Error('Invalid source metadata');
  const lat=source.latitude, lng=source.longitude;
  if (!((lat === null && lng === null) || (typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat)<=90 && typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng)<=180))) throw new Error('Invalid source coordinates');
  const {capturedAt,timezoneKnown,offsetMinutes,localDateTime}=time;
  if (typeof timezoneKnown !== 'boolean' || (offsetMinutes !== null && (typeof offsetMinutes !== 'number' || !Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes)>840))) throw new Error('Invalid source time');
  let checked: PhotoTimeResult;
  if (time.source === 'DateTimeOriginal' || time.source === 'CreateDate') {
    if(typeof localDateTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(localDateTime)) throw new Error('Invalid source time');
    const offset = typeof offsetMinutes === 'number' ? `${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offsetMinutes)/60)).padStart(2,'0')}:${String(Math.abs(offsetMinutes)%60).padStart(2,'0')}` : undefined;
    const rawDate=localDateTime.slice(0,10).replace(/-/g,':')+' '+localDateTime.slice(11);
    checked=parsePhotoTime({[time.source]:rawDate,...(offset ? {[time.source === 'DateTimeOriginal' ? 'OffsetTimeOriginal' : 'OffsetTimeDigitized']:offset} : {})});
  } else if (time.source === 'GPSDateTime' && typeof capturedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capturedAt) && Number.isFinite(Date.parse(capturedAt)) && new Date(capturedAt).toISOString()===capturedAt) {
    checked={capturedAt,timezoneKnown:true,offsetMinutes:0,source:'GPSDateTime',localDateTime:null};
  } else if (time.source === 'unknown') checked=parsePhotoTime({});
  else throw new Error('Invalid source time');
  if (checked.capturedAt!==capturedAt || checked.timezoneKnown!==timezoneKnown || checked.offsetMinutes!==offsetMinutes || checked.localDateTime!==localDateTime) throw new Error('Invalid source time');
  return {sha256:source.sha256,mode:source.mode as 'optimized' | 'original',time:checked,latitude:lat as number|null,longitude:lng as number|null};
}
export async function importPhoto(accountId:string, tripId:string, file:File, thumbnail:File, size:unknown, sourceInput?:unknown): Promise<Photo|null> {
  if (!file.size || file.size > MAX_FILE) throw new Error('File must be between 1 byte and 25 MB');
  if (!thumbnail || !thumbnail.size || thumbnail.size > MAX_THUMB) throw new Error('A thumbnail under 2 MB is required');
  const [buffer, thumbBuffer] = await Promise.all([file.arrayBuffer(), thumbnail.arrayBuffer()]);
  const bytes = new Uint8Array(buffer), thumb = new Uint8Array(thumbBuffer), mimeType=imageType(bytes), thumbType=imageType(thumb);
  if (!mimeType) throw new Error('Unsupported image. Use JPEG, PNG, WebP, or HEIC');
  if (thumbType !== 'image/jpeg' && thumbType !== 'image/png') throw new Error('Invalid thumbnail');
  const thumbSize=thumbnailDimensions(thumb,thumbType);
  if(!thumbSize.width || !thumbSize.height || thumbSize.width>2048 || thumbSize.height>2048) throw new Error('Invalid thumbnail dimensions');
  const {width,height}=dimensions(size);
  const storedHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)), b=>b.toString(16).padStart(2,'0')).join('');
  const source=sourceMetadata(sourceInput);
  if (source?.mode === 'original' && source.sha256 !== storedHash) throw new Error('Source hash does not match original');
  if (source?.mode === 'optimized' && mimeType !== 'image/jpeg') throw new Error('Optimized image must be JPEG');
  const hash=source?.sha256 || storedHash;
  let exif:Record<string,unknown>={}, raw:Record<string,unknown>={};
  try { exif=await exifr.parse(bytes,{gps:true,exif:true,tiff:true}) || {}; } catch { /* optional EXIF */ }
  try { raw=await exifr.parse(bytes,{gps:true,exif:true,tiff:true,reviveValues:false}) || {}; } catch { /* optional EXIF */ }
  const timeMetadata=source?.time || parsePhotoTime(raw), capturedAt=timeMetadata.capturedAt;
  const lat=source ? source.latitude : exif.latitude, lng=source ? source.longitude : exif.longitude;
  const valid=typeof lat==='number' && Number.isFinite(lat) && Math.abs(lat)<=90 && typeof lng==='number' && Number.isFinite(lng) && Math.abs(lng)<=180;
  const latitude=valid ? lat as number : null, longitude=valid ? lng as number : null;
  const id=crypto.randomUUID(), originalPath=`originals/${id}`, thumbnailPath=`thumbnails/${id}`;
  const photo:Photo={id,accountId,tripId,fileName:file.name,mimeType,width,height,sha256:hash,capturedAt,latitude,longitude,placeName:'',country:'',notes:'',locationSource:valid?'exif':'unknown',confirmed:false,originalPath,thumbnailPath,timeSource:capturedAt?'exif':'unknown',timeMetadata,metadata:{capturedAt,latitude,longitude},createdAt:new Date().toISOString()};
  if (source) Object.assign(photo, {storageMode:source.mode});
  const bucket=storage();
  try {
    const writes=await Promise.allSettled([bucket.put(originalPath,buffer,{httpMetadata:{contentType:mimeType}}),bucket.put(thumbnailPath,thumbBuffer,{httpMetadata:{contentType:thumbType}})]);
    const failure=writes.find(x=>x.status==='rejected'); if(failure?.status==='rejected') throw failure.reason;
    const inserted=await mutateStore(s=>{if(!s.trips.some(t=>t.id===tripId && t.accountId===accountId)) throw new Error('Trip not found'); if(s.photos.some(p=>p.accountId===accountId && p.tripId===tripId && p.sha256===hash)) return false; s.photos.push(photo); return true;});
    if (!inserted) { await Promise.all([bucket.delete(originalPath),bucket.delete(thumbnailPath)]); return null; }
    return photo;
  } catch(e) { await Promise.allSettled([bucket.delete(originalPath),bucket.delete(thumbnailPath)]); throw e; }
}
