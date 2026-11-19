import type { FeatureCollection, LineString, Point } from 'geojson';
import type { Photo } from '@/lib/types';
import { photoCaptureDate } from './photo-time';
export function locatedPhotos(photos: Photo[]) {
  return photos.filter(p => p.latitude !== null && p.longitude !== null && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180);
}
export function pointData(photos: Photo[]): FeatureCollection<Point> {
 return {type:'FeatureCollection',features:locatedPhotos(photos).map(p=>({type:'Feature',geometry:{type:'Point',coordinates:[p.longitude!,p.latitude!]},properties:{id:p.id}}))};
}

// These are connections between photographed stops, independent of the transport or road taken.
export function timelineRouteData(photos: Photo[]): FeatureCollection<LineString> {
  const stops = locatedPhotos(photos).filter(photo => photoCaptureDate(photo));
  const coordinates: number[][] = [];
  for (const photo of stops) {
    const previous = coordinates.at(-1);
    const longitude = photo.longitude!, latitude = photo.latitude!;
    if (!previous || previous[0] !== longitude || previous[1] !== latitude) coordinates.push([longitude, latitude]);
  }
  return { type: 'FeatureCollection', features: coordinates.length < 2 ? [] : [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } },
  ] };
}
export function routeData(photos: Photo[]): FeatureCollection<LineString> {
 const trips=new Map<string,Photo[]>();
 for(const p of locatedPhotos(photos)) {
  // Date-only values do not establish a time of day and missing times cannot establish visit order.
  if (!p.capturedAt || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(p.capturedAt) || !Number.isFinite(Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(p.capturedAt)?p.capturedAt:p.capturedAt+'Z'))) continue;
  const group=trips.get(p.tripId) || []; group.push(p); trips.set(p.tripId,group);
 }
 const features: FeatureCollection<LineString>['features']=[];
 for(const [tripId, list] of trips) {
  // Unknown offsets or equal times cannot reliably establish sequence, so split such edges.
  const toTime=(p:Photo)=> /(?:Z|[+-]\d\d:\d\d)$/i.test(p.capturedAt!) ? Date.parse(p.capturedAt!) : null;
  const timed=list.map(p=>({p,t:toTime(p)})).filter((x): x is {p:Photo;t:number}=>x.t!==null).sort((a,b)=>a.t-b.t || a.p.id.localeCompare(b.p.id));
  const tied = new Set<number>(); for(let i=1;i<timed.length;i++) if(timed[i-1].t===timed[i].t) tied.add(timed[i].t);
  for(let i=1;i<timed.length;i++) if(timed[i-1].t!==timed[i].t && !tied.has(timed[i-1].t) && !tied.has(timed[i].t)) {
   let a=timed[i-1].p.longitude!, b=timed[i].p.longitude!; if (b-a>180)b-=360; else if(b-a< -180)b+=360;
   features.push({type:'Feature',properties:{tripId},geometry:{type:'LineString',coordinates:[[a,timed[i-1].p.latitude!],[b,timed[i].p.latitude!]]}});
  }
 }
 return {type:'FeatureCollection',features};
}
