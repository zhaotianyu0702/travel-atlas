import { photoCaptureDate } from './photo-time';
import type { Photo, Trip } from './types';

const COLORS = ['#9c4736','#235f61','#78628c','#976718','#386c96','#56673d','#a65075','#3f6180'];
export const HIGHLIGHT_POOL_LIMIT = 32, HIGHLIGHT_BATCH = 8, TRIP_HIGHLIGHT_LIMIT = 12;

function rankDate(p:Photo) { return photoCaptureDate(p) ? p.capturedAt! : '9999'; }
export function spread<T>(items:T[], limit:number):T[] {
  if (items.length<=limit) return items;
  if(limit<=1) return limit===1 ? [items[0]] : [];
  return Array.from({length:limit},(_,i)=>items[Math.round((items.length-1)*i/(limit-1))]);
}
export function highlightBatches(photos:Photo[]) {
  const active=photos.filter(p=>!p.deletedAt).sort((a,b)=>rankDate(a).localeCompare(rankDate(b))||a.id.localeCompare(b.id));
  const pool=spread(active,HIGHLIGHT_POOL_LIMIT);
  const result:Photo[][]=[];
  for(let i=0;i<pool.length;i+=HIGHLIGHT_BATCH) result.push(pool.slice(i,i+HIGHLIGHT_BATCH));
  return result;
}
export function tripHighlights(trip:Trip,photos:Photo[]):Photo[] {
  const active=photos.filter(p=>p.tripId===trip.id&&!p.deletedAt), byId=new Map(active.map(p=>[p.id,p]));
  const selected=(trip.highlightPhotoIds??[]).map(id=>byId.get(id)).filter((p):p is Photo=>!!p);
  const manual=active.filter(p=>p.favorite || p.id===trip.coverPhotoId);
  const fallback=selected.length ? selected : spread(active.filter(p=>!p.favorite&&p.id!==trip.coverPhotoId).sort((a,b)=>rankDate(a).localeCompare(rankDate(b))||a.id.localeCompare(b.id)),8);
  return [...new Map([...manual,...fallback].map(p=>[p.id,p])).values()].slice(0,TRIP_HIGHLIGHT_LIMIT);
}
export const hasLocation=(p:Photo)=>typeof p.latitude==='number'&&Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&typeof p.longitude==='number'&&Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180;
export function tripMarkersFor(trips:Trip[],photos:Photo[]) {
  const byTrip=new Map<string,Photo[]>();
  for(const p of photos) if (!p.deletedAt&&hasLocation(p)){
    const list=byTrip.get(p.tripId);if(list)list.push(p);else byTrip.set(p.tripId,[p]);
  }
  const ordered=[...trips].sort((a,b)=>a.id.localeCompare(b.id));
  // Anchor the trip bubble to a real photo nearest the trip's spherical center.
  // Sampling bounds work for very large albums and does not hide any photos in the full view.
  const xyz=(p:Photo)=>{const lat=p.latitude!*Math.PI/180,lon=p.longitude!*Math.PI/180;return [Math.cos(lat)*Math.cos(lon),Math.cos(lat)*Math.sin(lon),Math.sin(lat)];};
  return ordered.flatMap((trip,index)=>{
    const located=byTrip.get(trip.id);
    if(!located?.length)return [];
    const eligible=spread(located,96), xyzs=eligible.map(xyz);
    const mean=xyzs.reduce((s,v)=>[s[0]+v[0],s[1]+v[1],s[2]+v[2]],[0,0,0]);
    const dot=(v:number[])=>v[0]*mean[0]+v[1]*mean[1]+v[2]*mean[2];
    const nearest=xyzs.reduce((best,v,i)=>dot(v)>dot(xyzs[best])?i:best,0);
    const p=eligible[nearest],cover=located.find(v=>v.id===trip.coverPhotoId)??p;
    return [{id:trip.id,title:trip.title,latitude:p.latitude!,longitude:p.longitude!,color:COLORS[index%COLORS.length],coverUrl:`/api/media/${encodeURIComponent(cover.id)}?variant=thumb`}];
  });
}
