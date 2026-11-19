export interface PhotoTimeResult {
  capturedAt: string | null;
  timezoneKnown: boolean;
  offsetMinutes: number | null;
  source: 'DateTimeOriginal' | 'CreateDate' | 'GPSDateTime' | 'unknown';
  localDateTime: string | null;
}
export function photoCaptureDate(photo: { capturedAt: string | null; timeSource?: string; timeMetadata?: { localDateTime: string | null } }): string {
  if (!photo.capturedAt) return '';
  return (photo.timeSource === 'user' ? photo.capturedAt : photo.timeMetadata?.localDateTime || photo.capturedAt).slice(0,10);
}
function wallTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [,year,month,day,hour,minute,second] = match;
  const iso=`${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const ms=Date.parse(`${iso}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,19)!==iso) return null;
  return iso;
}
function parseOffset(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match=/^([+-])(\d{2}):(\d{2})$/.exec(value.trim());
  if(!match) return null;
  const hours=Number(match[2]), minutes=Number(match[3]);
  if(hours>14 || minutes>59 || (hours===14 && minutes!==0)) return null;
  return (match[1]==='-'?-1:1)*(hours*60+minutes);
}
function gpsUtc(raw: Record<string,unknown>): string | null {
  if (typeof raw.GPSDateStamp!=='string' || !Array.isArray(raw.GPSTimeStamp) || raw.GPSTimeStamp.length!==3) return null;
  const date=raw.GPSDateStamp.trim(), [hour,minute,second]=raw.GPSTimeStamp;
  if (![hour,minute,second].every(n=>typeof n==='number'&&Number.isFinite(n)) || !Number.isInteger(hour) || !Number.isInteger(minute) || hour<0 || hour>23 || minute<0 || minute>59 || second<0 || second>=60) return null;
  const sec=Math.floor(second), frac=Math.round((second-sec)*1000);
  const wall=wallTime(`${date} ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:${String(sec).padStart(2,'0')}`);
  return wall ? new Date(Date.parse(wall+'Z')+frac).toISOString() : null;
}
/** EXIF is a wall clock; only an explicit EXIF offset establishes its UTC instant. */
export function parsePhotoTime(raw: Record<string,unknown>): PhotoTimeResult {
  for (const [field,offsetField] of [['DateTimeOriginal','OffsetTimeOriginal'],['CreateDate','OffsetTimeDigitized']] as const) {
    const localDateTime=wallTime(raw[field]); if(!localDateTime) continue;
    const offsetMinutes=parseOffset(raw[offsetField]);
    return {capturedAt:offsetMinutes===null?localDateTime:new Date(Date.parse(localDateTime+'Z')-offsetMinutes*60_000).toISOString(),timezoneKnown:offsetMinutes!==null,offsetMinutes,source:field,localDateTime};
  }
  // GPS is a fallback only when capture-time tags are absent, not when they are malformed.
  if (raw.DateTimeOriginal == null && raw.CreateDate == null) {
    const gps=gpsUtc(raw);
    if(gps) return {capturedAt:gps,timezoneKnown:true,offsetMinutes:0,source:'GPSDateTime',localDateTime:null};
  }
  return {capturedAt:null,timezoneKnown:false,offsetMinutes:null,source:'unknown',localDateTime:null};
}
