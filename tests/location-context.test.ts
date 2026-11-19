import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocationContext, gateLocationCandidate } from '../lib/location-context';
import type { AiSuggestion, Photo } from '../lib/types';

const photo = (id: string, capturedAt: string | null, latitude: number | null = null, longitude: number | null = null): Photo => ({
  id, accountId:'a', tripId:'trip', fileName:'x.jpg', mimeType:'image/jpeg', width:1,height:1,sha256:id,
  capturedAt,latitude,longitude,placeName:'',country:'',notes:'',locationSource:latitude === null ? 'unknown' : 'exif',confirmed:false,
  originalPath:'',thumbnailPath:'',metadata:{capturedAt,latitude,longitude},createdAt:''
});
const t = photo('target','2026-03-01T12:00:00Z');
const before = photo('before','2026-03-01T11:50:00Z',42,-71);
const after = photo('after','2026-03-01T12:10:00Z',42.002,-71);
const candidate: AiSuggestion['placeCandidates'][number] = {photoId:'target',placeName:'Park',country:'USA',latitude:42.001,longitude:-71,confidence:'medium',reason:'Nearby photos',precision:'landmark',supportingPhotoIds:[]};

test('selects closest bounded neighbors and requires two consistent observed anchors', () => {
  const photos=[before,after,photo('b2','2026-03-01T11:55:00Z'),photo('a2','2026-03-01T12:05:00Z'),photo('far','2026-03-01T10:00:00Z'),{...after,id:'other-trip',tripId:'other'}];
  const context=buildLocationContext(t,photos);
  assert.deepEqual(context.photos.map(p=>p.id),['target','before','b2','a2','after']);
  assert.deepEqual([context.anchors?.before.photoId,context.anchors?.after.photoId],['before','after']);
  const accepted=gateLocationCandidate(candidate,t,context,{distinctiveVisualVerified:false});
  assert.equal(accepted.provenance,'bracketing-context');
  assert.equal(accepted.candidate.precision,'locality');
  assert.deepEqual(accepted.candidate.supportingPhotoIds,['before','after']);
  assert.equal(accepted.approximate,true);
});

test('conflicting location evidence, weak confidence, and distant candidates resolve to no guess', () => {
  const conflict=photo('conflict','2026-03-01T12:02:00Z',43,-71);
  const context=buildLocationContext(t,[before,after,conflict]);
  assert.equal(context.anchors,null);
  const unresolved=gateLocationCandidate(candidate,t,context,{distinctiveVisualVerified:false});
  assert.equal(unresolved.provenance,'unresolved');
  assert.deepEqual([unresolved.candidate.placeName,unresolved.candidate.latitude,unresolved.candidate.precision],['',null,'unknown']);
  const good=buildLocationContext(t,[before,after]);
  for (const bad of [{...candidate,confidence:'low' as const},{...candidate,latitude:43},{...candidate,precision:'region' as const}]) {
    assert.equal(gateLocationCandidate(bad,t,good,{distinctiveVisualVerified:false}).provenance,'unresolved');
  }
});

test('floating, missing and distant timestamps cannot establish context', () => {
  assert.equal(buildLocationContext({...t,capturedAt:'2026-03-01T12:00:00'},[before,after]).anchors,null);
  assert.equal(buildLocationContext(t,[{...before,capturedAt:'2026-03-01T11:50:00'},after]).anchors,null);
  assert.equal(buildLocationContext({...t,capturedAt:null},[before,after]).photos.length,1);
  assert.equal(buildLocationContext(t,[{...before,capturedAt:'2026-03-01T11:34:59Z'},after]).anchors,null);
});

test('unknown provenance is hidden and cannot anchor; deleted and other accounts excluded', () => {
  const unknown={...before,locationSource:'unknown' as const};
  const c=buildLocationContext(t,[unknown,after,{...after,id:'deleted',deletedAt:'2026-03-02'},{...before,id:'foreign',accountId:'b'}]);
  assert.equal(c.anchors,null);
  assert.deepEqual([c.metadata.find(p=>p.id==='before')?.latitude,c.metadata.find(p=>p.id==='before')?.longitude],[null,null]);
  assert.deepEqual(c.photos.map(p=>p.id),['target','before','after']);
});

test('verified visual evidence is an explicit separate caller decision', () => {
  const c=buildLocationContext(t,[]);
  assert.equal(gateLocationCandidate(candidate,t,c,{distinctiveVisualVerified:false}).provenance,'unresolved');
  assert.equal(gateLocationCandidate(candidate,t,c,{distinctiveVisualVerified:true}).provenance,'verified-visual');
});
