import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationContext } from '../lib/location-context';
import { estimateLocation, estimateSuggestion } from '../lib/location-estimate';
import type { Photo } from '../lib/types';

const photo = (id:string, capturedAt:string|null, latitude:number|null=null, longitude:number|null=null):Photo => ({id, accountId:'a', tripId:'t', fileName:'x', mimeType:'image/jpeg', width:1, height:1, sha256:id, capturedAt, latitude, longitude, placeName:'', country:'', notes:'', locationSource:latitude === null ? 'unknown' : 'exif', confirmed:false, originalPath:'', thumbnailPath:'', metadata:{capturedAt,latitude,longitude}, createdAt:''});
const target = photo('target','2026-03-01T12:00:00Z');
const before = photo('before','2026-03-01T11:50:00Z',0,179.999);
const after = photo('after','2026-03-01T12:10:00Z',0,-179.999);
const match = {verdict:'match' as const, evidencePhotoIds:['after','before'], reason:'same scene'};

test('interpolates across the dateline using explicit instants', () => {
  const result = estimateLocation(buildLocationContext(target,[before,after]));
  assert.ok(result);
  assert.equal(result.latitude,0);
  assert.equal(Math.abs(result.longitude),180);
});

test('rejects missing, distant, invalid, or inconsistent anchor evidence', () => {
  const context = buildLocationContext(target,[before,after]);
  assert.equal(estimateLocation(buildLocationContext(target,[before])),null);
  assert.equal(estimateLocation(buildLocationContext(target,[before,{...after,longitude:-179.9}])),null);
  assert.equal(estimateLocation({...context,photos:context.photos.map(p=>p.id==='target'?{...p,capturedAt:'2026-02-30T12:00:00Z'}:p)}),null);
  assert.equal(estimateLocation({...context,photos:context.photos.map(p=>p.id==='before'?{...p,capturedAt:'2026-03-01T12:01:00Z'}:p)}),null);
  assert.equal(estimateLocation({...context,photos:context.photos.map(p=>p.id==='before'?{...p,capturedAt:'2026-03-01T11:50:00'}:p)}),null);
  assert.equal(estimateLocation({...context,anchors:{...context.anchors!,before:{...context.anchors!.before,latitude:20}}}),null);
});

test('uses only anchor coordinates and saved labels, requiring exactly both cited IDs', () => {
  const saved = {...target,placeName:'Saved place',country:'Saved country'};
  const context = buildLocationContext(saved,[before,after]);
  const injected = {...match, latitude:50,longitude:50,placeName:'Invented',country:'Invented'};
  const suggestion = estimateSuggestion(context,saved,injected);
  assert.ok(suggestion);
  assert.equal(Math.abs(suggestion.longitude!),180);
  assert.deepEqual([suggestion.placeName,suggestion.country,suggestion.confidence],['Saved place','Saved country','medium']);
  for (const decision of [{...match,verdict:'different' as const},{...match,verdict:'uncertain' as const},{...match,evidencePhotoIds:['before']},{...match,evidencePhotoIds:['before','after','extra']},{...match,evidencePhotoIds:['before','before']}]) assert.equal(estimateSuggestion(context,saved,decision),null);
  assert.equal(estimateSuggestion(context,{...saved,id:'other'},match),null);
});
