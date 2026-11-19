import test from 'node:test';
import assert from 'node:assert/strict';
import { samplePhotos, targetsFor, timeEvidence } from '../lib/ai-input';
import { parsePhotoTime } from '../lib/photo-time';
import { suggestionSchema, validateSuggestion } from '../lib/ai-schema';
import type { Photo } from '../lib/types';

const photo = (id: string, capturedAt: string | null = null): Photo => ({
  id, accountId:'local', tripId:'trip', fileName:'photo.jpg', mimeType:'image/jpeg', width:1, height:1, sha256:id,
  capturedAt, latitude:null, longitude:null, placeName:'', country:'', notes:'', locationSource:'unknown', confirmed:false,
  originalPath:'', thumbnailPath:'', metadata:{capturedAt,latitude:null,longitude:null}, createdAt:''
});
const suggestion = () => ({title:'Trip',summary:'',highlights:[],selectedPhotoIds:['p0'],groups:[],placeCandidates:[],timeCandidates:[],issues:[]});

test('targeted sampling keeps undated targets, bounds images and rejects invalid targets', () => {
  const photos = Array.from({length:12}, (_,i) => photo(`p${i}`, i ? `2026-01-${String(i).padStart(2,'0')}` : null));
  const sample = samplePhotos(photos,{targetPhotoIds:['p0','p1']});
  assert.equal(sample.length,8);
  assert.deepEqual(sample.slice(0,2).map(p=>p.id),['p0','p1']);
  assert.throws(()=>targetsFor(photos,{targetPhotoIds:['p0','p1','p2']}));
  assert.throws(()=>targetsFor(photos,{targetPhotoIds:['unowned']}));
});

test('model results cannot replace observed coordinates or cite unavailable photos', () => {
  const recorded={...photo('p0'),latitude:42,longitude:-71};
  assert.throws(()=>validateSuggestion({...suggestion(),placeCandidates:[{photoId:'p0',placeName:'',country:'',latitude:null,longitude:null,confidence:'low',reason:'',precision:'unknown',supportingPhotoIds:[]}]},[recorded]));
  assert.throws(()=>validateSuggestion({...suggestion(),selectedPhotoIds:['other']},[photo('p0')]));
  assert.deepEqual(validateSuggestion(suggestion(),[photo('p0')]),suggestion());
});

test('structured output schema requires every field and disallows extra object properties', () => {
  const visit = (schema: any) => {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties,false);
      assert.deepEqual([...schema.required].sort(),Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(visit);
    }
    if (schema.items) visit(schema.items);
  };
  visit(suggestionSchema);
});

test('weak visual evidence cannot pin a generic scene or overwrite any recorded label', () => {
  const candidate = {photoId:'p0', placeName:'A guessed capital', country:'A guessed country', latitude:42, longitude:-71, confidence:'high', reason:'An ordinary room', precision:'locality', supportingPhotoIds:[]};
  const issue = {photoId:'p0', kind:'insufficient-evidence', message:'No reliable clues'};
  const result = validateSuggestion({...suggestion(), placeCandidates:[candidate], issues:[issue]}, [photo('p0')]);
  assert.deepEqual(result.placeCandidates.map(c=>[c.placeName,c.country,c.latitude,c.longitude,c.precision]), [['','',null,null,'unknown']]);
  const noCandidate = validateSuggestion({...suggestion(), issues:[issue]}, [{...photo('p0'),country:'Already recorded'}]);
  assert.equal(noCandidate.placeCandidates[0].country,'Already recorded');
  const coarse = validateSuggestion({...suggestion(),placeCandidates:[{...candidate,precision:'region'}]}, [photo('p0')]);
  assert.equal(coarse.placeCandidates[0].latitude,null);
  assert.equal(coarse.placeCandidates[0].longitude,null);
  const useful = validateSuggestion({...suggestion(),placeCandidates:[{...candidate,precision:'landmark'}]}, [photo('p0')]);
  assert.equal(useful.placeCandidates[0].latitude,42);
});

test('EXIF time crossing midnight keeps the recorded local date; an unknown offset remains unknown', () => {
  const raw={DateTimeOriginal:'2026:01:02 00:12:00',OffsetTimeOriginal:'+02:00'};
  const when=parsePhotoTime(raw);
  assert.equal(when.capturedAt, '2026-01-01T22:12:00.000Z');
  assert.deepEqual(timeEvidence({...photo('p0',when.capturedAt),timeMetadata:when}),{localDate:'2026-01-02',timezoneKnown:true});
  const floating=parsePhotoTime({DateTimeOriginal:raw.DateTimeOriginal});
  assert.equal(floating.capturedAt, '2026-01-02T00:12:00');
  assert.deepEqual(timeEvidence({...photo('p0',floating.capturedAt),timeMetadata:floating}),{localDate:'2026-01-02',timezoneKnown:false});
  assert.equal(parsePhotoTime({DateTimeOriginal:'2026:02:30 00:12:00'}).capturedAt,null);
  assert.equal(parsePhotoTime({}).capturedAt,null);
});
