import { waitUntil } from 'cloudflare:workers';
import { mutateStore, readStore } from './cloud-store';
import { roadRouteKey, routePoints } from './road-route';
import type { EstimatedRoute, Store } from './types';

const sourceKey=(s:Store,accountId:string,tripId:string)=>roadRouteKey(routePoints(s.photos,accountId,tripId));

export async function roadRouteStatus(accountId:string,tripId:string) {
  const s=await readStore();
  if(!s.trips.some(t=>t.id===tripId&&t.accountId===accountId))throw new Error('Trip not found');
  const request=s.routeRequests?.find(r=>r.tripId===tripId);
  if(!request||request.sourceKey!==sourceKey(s,accountId,tripId))return {status:'unavailable' as const};
  if(request.status==='running'&&Date.now()-request.startedAt>45_000)return {status:'failed' as const};
  return {status:request.status};
}

export async function scheduleRoadRoute(accountId:string,tripId:string) {
  const now=Date.now();
  const claim=await mutateStore(s=>{
    const trip=s.trips.find(t=>t.id===tripId&&t.accountId===accountId);
    if(!trip)throw new Error('Trip not found');
    const points=routePoints(s.photos,accountId,tripId), key=roadRouteKey(points);
    s.routeRequests ||= [];
    const old=s.routeRequests.find(r=>r.tripId===tripId);
    if(old?.sourceKey===key && (old.status==='done'||now-old.startedAt<5*60_000))return null;
    if(points.length<2){trip.estimatedRoute=null;s.routeRequests=s.routeRequests.filter(r=>r.tripId!==tripId);return null;}
    // Global reservation across Worker instances, using the workspace CAS.
    const reservedAt=Math.max(now,(s.routeLastRequestAt||0)+2000);
    if(reservedAt-now>10_000)return null;
    s.routeLastRequestAt=reservedAt;
    s.routeRequests=s.routeRequests.filter(r=>r.tripId!==tripId);
    s.routeRequests.push({tripId,sourceKey:key,startedAt:now,status:'running'});
    trip.estimatedRoute=null;
    return {key,points,startedAt:now,reservedAt};
  });
  if(!claim)return {scheduled:false};
  waitUntil((async()=>{
    let route:EstimatedRoute|null=null;
    try {
      if(claim.reservedAt>Date.now())await new Promise(resolve=>setTimeout(resolve,claim.reservedAt-Date.now()));
      const coords=claim.points.map(p=>`${p.longitude.toFixed(5)},${p.latitude.toFixed(5)}`).join(';');
      const response=await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=false&geometries=geojson&steps=true`,{headers:{'User-Agent':'TravelAtlasPrivate/1.0'},signal:AbortSignal.timeout(12000)});
      if(!response.ok)throw new Error('Routing unavailable');
      const data=await response.json() as {code?:string;routes?:{distance:number;duration:number;legs?:{distance:number;steps?:{geometry?:{coordinates?:unknown}}[]}[]}[];waypoints?:{distance?:number}[]};
      const candidate=data.routes?.[0], legs=candidate?.legs;
      if(data.code!=='Ok'||!candidate||!Number.isFinite(candidate.distance)||!Number.isFinite(candidate.duration)||!legs||legs.length!==claim.points.length-1||!data.waypoints||data.waypoints.length!==claim.points.length||data.waypoints.some(w=>typeof w.distance!=='number'||w.distance>2000))throw new Error('Invalid route');
      let totalPoints=0;
      const segments=legs.map((leg,i)=>{
        if(!Number.isFinite(leg.distance)||leg.distance>500_000||!leg.steps)throw new Error('Invalid route leg');
        const coordinates:[number,number][]=[];
        for(const step of leg.steps){
          const line=step.geometry?.coordinates;
          if(!Array.isArray(line)||!line.every(p=>Array.isArray(p)&&p.length>=2&&typeof p[0]==='number'&&Number.isFinite(p[0])&&Math.abs(p[0])<=180&&typeof p[1]==='number'&&Number.isFinite(p[1])&&Math.abs(p[1])<=90))throw new Error('Invalid route geometry');
          for(const p of line)coordinates.push([p[0],p[1]]);
        }
        totalPoints+=coordinates.length;
        if(coordinates.length<2||totalPoints>20000)throw new Error('Invalid route geometry');
        return {fromPhotoId:claim.points[i].id,toPhotoId:claim.points[i+1].id,coordinates};
      });
      route={provider:'OSRM',generatedAt:new Date().toISOString(),segments,distanceMeters:candidate.distance,durationSeconds:candidate.duration,waypointPhotoIds:claim.points.map(p=>p.id)};
    } catch { /* Best effort: photo import remains successful. */ }
    await mutateStore(s=>{
      const trip=s.trips.find(t=>t.id===tripId&&t.accountId===accountId), request=s.routeRequests?.find(r=>r.tripId===tripId);
      if(!trip||!request||request.sourceKey!==claim.key||request.startedAt!==claim.startedAt||sourceKey(s,accountId,tripId)!==claim.key)return;
      trip.estimatedRoute=route;
      request.status=route?'done':'failed';
    });
  })().catch(()=>{}));
  return {scheduled:true};
}
