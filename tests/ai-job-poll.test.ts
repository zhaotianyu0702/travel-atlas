import test from 'node:test';
import assert from 'node:assert/strict';
import { AiPollError, failedLocationPhotoIds, pollAiJob } from '../lib/ai-job-poll';

test('polling resumes after a network loss and stops when complete', async () => {
  const queue: Array<() => void> = [];
  const delays: number[] = [];
  const seen: string[] = [];
  let calls = 0;
  pollAiJob({
    load: async () => { calls++; if (calls === 1) throw new TypeError('offline'); return {status: calls === 2 ? 'running' : 'succeeded'}; },
    onUpdate: value => seen.push(value.status), onWaiting: () => seen.push('waiting'), onError: message => seen.push(message),
    schedule: (fn, delay) => { queue.push(fn); delays.push(delay); return 0 as unknown as ReturnType<typeof setTimeout>; },
  });
  while (queue.length) { queue.shift()!(); await new Promise(resolve => setImmediate(resolve)); }
  assert.deepEqual(seen, ['waiting', 'running', 'succeeded']);
  assert.deepEqual(delays, [2000, 4000, 2000]);
  assert.equal(calls, 3);
});

test('polling reports terminal errors without retrying', async () => {
  const queue: Array<() => void> = [];
  const seen: string[] = [];
  pollAiJob({load: async () => {throw new AiPollError('Sign in again', false);}, onUpdate: () => {}, onWaiting: () => seen.push('waiting'), onError: message => seen.push(message), schedule: fn => {queue.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>;}});
  queue.shift()!(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['Sign in again']);
  assert.equal(queue.length, 0);
});

test('location retries target failures, not unresolved or already repaired photos', () => {
  const photos = ['failed', 'unresolved', 'repaired'].map(id => ({id, confirmed: id === 'repaired', latitude: null, longitude: null}));
  const jobs = [{id:'1', photoId:'failed', status:'failed'}, {id:'2', photoId:'unresolved', status:'succeeded'}, {id:'3', photoId:'repaired', status:'failed'}];
  assert.deepEqual(failedLocationPhotoIds(jobs, photos), ['failed']);
  assert.deepEqual(failedLocationPhotoIds([...jobs, {id:'4', photoId:'failed', status:'running'}], photos), []);
});
