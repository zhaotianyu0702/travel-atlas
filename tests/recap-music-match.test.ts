import test from 'node:test';
import assert from 'node:assert/strict';
import { RECAP_MUSIC } from '../lib/recap-music-library';
import { rankRecapMusic, recommendRecapMusic } from '../lib/recap-music-match';

const match = recommendRecapMusic;

test('coast, desert drive and underwater edits have distinct, relevant recommendations', () => {
  const coast = match({ title: 'Coastal light', photos: [{ id: 'a', description: 'Waves along a beach at sunset' }] });
  const desert = match({ title: 'Desert drive', photos: [{ id: 'b', description: 'A car crossing sand dunes' }] });
  const dive = match({ title: 'Underwater world', photos: [{ id: 'c', description: 'Scuba divers above a coral reef' }] });
  assert.equal(coast.profiles[0], 'coast');
  assert.equal(desert.profiles[0], 'desert-drive');
  assert.equal(dive.profiles[0], 'dive');
  assert.equal(new Set([coast.id, desert.id, dive.id]).size, 3);
});

test('selected photo evidence changes a generic edit, independent of country', () => {
  const coast = match({ title: 'Namibia', photos: [{ id: 'a', place: 'Namibia', description: 'Ocean waves on the beach' }] });
  const desert = match({ title: 'Namibia', photos: [{ id: 'b', place: 'Namibia', description: 'Desert dunes and a road' }] });
  assert.equal(coast.profiles[0], 'coast');
  assert.equal(desert.profiles[0], 'desert-drive');
  assert.notEqual(coast.id, desert.id);
  assert.equal(match({ title: 'Namibia', photos: [{ id: 'a', place: 'Namibia' }] }).id, RECAP_MUSIC[0].id);
});

test('coast alone does not imply diving and unused beat captions are ignored', () => {
  const input = { photos: [{ id: 'a', tags: ['beach', 'ocean'] }], beats: [{ photoIds: ['other'], caption: 'Scuba diving underwater' }] };
  assert.equal(match(input).profiles[0], 'coast');
  assert.equal(match({ photos: input.photos }).id, match(input).id);
});

test('Chinese themes and photo descriptions match and sparse inputs are stable', () => {
  assert.equal(match({ theme: '沙漠自驾', photos: [{ id: 'a', description: '沙丘和公路' }] }).profiles[0], 'desert-drive');
  assert.equal(match({ title: '海底世界', photos: [{ id: 'a', description: '潜水和珊瑚' }] }).profiles[0], 'dive');
  assert.equal(match({ theme: '海边', photos: [{ id: 'a', description: '海浪和沙滩' }] }).profiles[0], 'coast');
  assert.equal(match({}).id, RECAP_MUSIC[0].id);
  assert.equal(match({}).id, match({}).id);
});

test('explicit visual absence does not become positive evidence', () => {
  const absent = match({ photos: [{ id: 'a', description: 'No divers, ocean waves' }] });
  assert.equal(absent.profiles[0], 'coast');
});

test('specific subjects win over broad location and road words', () => {
  assert.equal(match({ title: 'Red Sea Diving' }).profiles[0], 'dive');
  assert.equal(match({ title: 'Rocky Coastlines' }).profiles[0], 'coast');
  assert.equal(match({ title: 'Namibia’s dunes' }).profiles[0], 'desert-drive');
  assert.equal(match({ title: 'Coastal road trip' }).profiles[0], 'coast');
  assert.notEqual(match({ title: 'City car driving' }).profiles[0], 'desert-drive');
});

test('presentation contributes a gentle, distinct preference without overriding the subject', () => {
  const coast = { title: 'Coastal beach', photos: [{ id: 'a', description: 'ocean waves' }] };
  for (const style of ['minimal', 'cinematic', 'dynamic']) {
    assert.equal(match({ ...coast, presentation: { style } }).profiles[0], 'coast');
  }
  assert.notEqual(match({ ...coast, presentation: { style: 'cinematic' } }).id, match({ ...coast, presentation: { style: 'dynamic' } }).id);
  assert.notEqual(match({ presentation: { style: 'minimal' } }).id, match({ presentation: { style: 'dynamic' } }).id);
});

test('each edit has a stable order, with variety between equally suitable soundtracks', () => {
  const ranking = (id: string) => rankRecapMusic({
    title: 'Underwater', photos: [{id, description: 'Scuba divers'}], presentation: { style: 'cinematic' },
  }).map(track => track.id);
  const first = ranking('dive-1');
  assert.deepEqual(first, ranking('dive-1'));
  assert.equal(new Set(first).size, RECAP_MUSIC.length);
  const chosen = new Set(Array.from({length: 30}, (_, i) => ranking(`dive-${i}`)[0]));
  assert.ok(chosen.size > 1);
  assert.ok([...chosen].every(id => RECAP_MUSIC.find(track => track.id === id)?.profiles[0] === 'dive'));
});
