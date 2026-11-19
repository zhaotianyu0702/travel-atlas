import test from 'node:test';
import assert from 'node:assert/strict';
import { highlightBatches, tripHighlights, tripMarkersFor } from '../lib/trip-presentation';
import type {Photo,Trip} from '../lib/types';
const make=(id:string,tripId='t',latitude:number|null=20,longitude:number|null=20)=>({
  id,tripId,accountId:'local',fileName:'photo.jpg',mimeType:'image/jpeg',width:1,height:1,sha256:id,capturedAt:null,latitude,longitude,placeName:'',country:'',notes:'',locationSource:'exif',confirmed:false,originalPath:'',thumbnailPath:'',metadata:{capturedAt:null,latitude,longitude},createdAt:'',
}) as Photo;
const trip=(id:string,extras:Partial<Trip>={}):Trip=>({id,accountId:'local',title:id,startDate:null,endDate:null,notes:'',createdAt:'',updatedAt:'',...extras});
test('large albums sample bounded batches from across the timeline without dropping actual records',()=>{
  const photos=Array.from({length:102},(_,i)=>make(String(i).padStart(3,'0')));
  photos[100].deletedAt='2026-01-01';
  const batches=highlightBatches(photos);
  assert.deepEqual(batches.map(x=>x.length),[8,8,8,8]);
  const ids=batches.flatMap(x=>x.map(p=>p.id));
  assert.equal(new Set(ids).size,32);
  assert.equal(ids[0],'000');assert.equal(ids.at(-1),'101');
  assert.ok(!ids.includes('100'));assert.equal(photos.length,102);
});
test('manual favorites complement AI picks and stale references cannot leak across trips',()=>{
  const favorite={...make('favorite'),favorite:true};
  const t=trip('t',{highlightPhotoIds:['pick','other','deleted']});
  assert.deepEqual(tripHighlights(t,[favorite,make('pick'),make('other','other'),{...make('deleted'),deletedAt:'now'}]).map(p=>p.id),['favorite','pick']);
});
test('overview shows one colored marker per located trip at an actual photo, including across the date line',()=>{
  const a=make('a','t',20,179), b=make('b','t',20,-179), c=make('c','q',15,40);
  const markers=tripMarkersFor([trip('t'),trip('q'),trip('empty')],[a,b,c,make('d','empty',null,null)]);
  assert.equal(markers.length,2);
  assert.notEqual(markers[0].color,markers[1].color);
  assert.equal(Math.abs(markers.find(p=>p.id==='t')!.longitude),179);
});
