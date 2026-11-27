import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recapImageKey, recapVisualEvidence } from '../lib/recap-visual-evidence';
import type { Photo, Store } from '../lib/types';

const photo = {id:'p', accountId:'owner', tripId:'t', sha256:'hash', thumbnailPath:'thumb'} as Photo;
const other = { ...photo, id:'other', accountId:'another' };
const batch = (description:string) => ({photoIds:['p'], status:'succeeded' as const, observations:[{photoId:'p',description}], imageKeys:{p:recapImageKey(photo,'model')}});
const job = (overrides:Record<string, unknown> = {}) => ({id:'j',accountId:'owner',tripId:'t',model:'model',source:JSON.stringify({photos:[['p','hash','thumb']]}),photoIds:['p'],requiredPhotoIds:[],status:'succeeded',error:null,cuts:null,createdAt:1,batches:[batch('  beach\n sunset  ')],synthesis:{photoIds:[],status:'succeeded'},...overrides}) as NonNullable<Store['recapCutJobs']>[number];

test('workspace visual descriptions require owned, current image evidence and deduplicate', () => {
  const jobs = [job(), job({createdAt:2,batches:[batch('latest\u0000 view')]}), job({createdAt:3,accountId:'another',batches:[batch('foreign')]}), job({createdAt:4,tripId:'other',batches:[batch('wrong trip')]}), job({createdAt:5,status:'failed',batches:[batch('failed')]}), job({createdAt:6,batches:[{...batch('stale'),imageKeys:{p:'old'}}]})];
  assert.deepEqual([...recapVisualEvidence([photo,other],jobs,'owner')], [['p','latest view']]);
  assert.equal(recapVisualEvidence([{...photo,sha256:'changed'}],jobs,'owner').size,0);
  assert.equal(recapVisualEvidence([{...photo,deletedAt:'now'}],jobs,'owner').size,0);
  assert.equal(recapVisualEvidence([photo],[job({photoIds:[]})],'owner').size,0);
  assert.equal(recapVisualEvidence([photo],[job({batches:[{...batch('x'),photoIds:[]}]})],'owner').size,0);
});

test('legacy fingerprint proves image identity; descriptions are bounded', () => {
  const legacy = job({batches:[{photoIds:['p'],status:'succeeded',observations:[{photoId:'p',description:'x'.repeat(400)}]}]});
  assert.equal(recapVisualEvidence([photo],[legacy],'owner').get('p')?.length,240);
  assert.equal(recapVisualEvidence([{...photo,thumbnailPath:'new'}],[legacy],'owner').size,0);
  assert.equal(recapVisualEvidence([photo],[{...legacy,source:'{}'}],'owner').size,0);
  assert.equal(recapVisualEvidence([photo],[job({batches:[{...batch('x'),imageKeys:{}}]})],'owner').size,0);
});
