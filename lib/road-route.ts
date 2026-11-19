import type { Photo } from './types';

export type RoutePoint = { id:string; latitude:number; longitude:number; capturedAt:string };
const km = (a:RoutePoint,b:RoutePoint) => {
  const rad=Math.PI/180, dlat=(b.latitude-a.latitude)*rad, dlon=(b.longitude-a.longitude)*rad;
  const h=Math.sin(dlat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dlon/2)**2;
  return 12742*Math.asin(Math.min(1,Math.sqrt(h)));
};
function routeInput(photos:Photo[],accountId:string,tripId:string) {
  return photos.filter(p=>p.accountId===accountId&&p.tripId===tripId&&!p.deletedAt)
    .map(p=>({id:p.id,latitude:p.latitude,longitude:p.longitude,capturedAt:p.capturedAt}))
    .sort((a,b)=>a.id.localeCompare(b.id));
}
export function routePoints(photos:Photo[],accountId:string,tripId:string):RoutePoint[] {
  const points=routeInput(photos,accountId,tripId).filter((p):p is RoutePoint=>
    typeof p.latitude==='number'&&Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&
    typeof p.longitude==='number'&&Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180&&
    typeof p.capturedAt==='string'&&Number.isFinite(Date.parse(p.capturedAt)))
    .sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt)||a.id.localeCompare(b.id));
  const groups:RoutePoint[][]=[]; let group:RoutePoint[]=[];
  for(const point of points){
    if(!group.length){group=[point];continue;}
    const previous=group[group.length-1], distance=km(previous,point);
    if(distance<0.25)continue;
    const hours=(Date.parse(point.capturedAt)-Date.parse(previous.capturedAt))/3600000;
    if(distance>300||(hours===0&&distance>1)||(hours>0&&distance/hours>160)) {if(group.length>1)groups.push(group);group=[point];}
    else group.push(point);
  }
  if(group.length>1)groups.push(group);
  // One bounded request, preserving chronological order and the most useful contiguous stretch.
  const best=groups.sort((a,b)=>b.length-a.length)[0]||[];
  if(best.length<=12)return best;
  return Array.from({length:12},(_,i)=>best[Math.round(i*(best.length-1)/11)]);
}
export const roadRouteKey=(points:RoutePoint[])=>JSON.stringify(points);
