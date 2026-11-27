import test from "node:test";
import assert from "node:assert/strict";
import { encodeSoundtrack, getSoundtrack, soundtrackTimeline } from "../lib/recap-soundtrack";

test("bookends and varied scene durations end on the soundtrack beat grid", () => {
  const timeline = soundtrackTimeline([3, 2.4, .25, 4.1], 30, 2);
  const boundaries = [timeline.first, ...timeline.starts.slice(1), timeline.starts.at(-1)! + timeline.durations.at(-1)!, timeline.totalFrames];
  assert.ok(boundaries.every(frame => (frame - 1) % 18 === 0));
  assert.deepEqual(timeline.durations, [90, 72, 18, 126]);
});

test("fractional frame beats do not drift over many scenes", () => {
  const track = { beatSeconds: 60 / 113, beatOffsetSeconds: .037 };
  const timeline = soundtrackTimeline(Array(250).fill(2), 30, 2, track);
  const initialBeat = Math.round((2 - track.beatOffsetSeconds) / track.beatSeconds);
  const beatsPerScene = Math.round(2 / track.beatSeconds);
  for (let i = 0; i < timeline.starts.length; i++) {
    assert.equal(timeline.starts[i], Math.round((track.beatOffsetSeconds + (initialBeat + i * beatsPerScene) * track.beatSeconds) * 30));
    if (i) assert.equal(timeline.starts[i], timeline.starts[i - 1] + timeline.durations[i - 1]);
  }
});

test("unknown soundtrack IDs fail rather than silently exporting the wrong song", () => {
  assert.throws(() => getSoundtrack("not-a-track"), /unavailable/);
  assert.ok(getSoundtrack().src);
});

test("audio loops on absolute beat boundaries across encoding blocks", async () => {
  const chunks: Float32Array[] = [];
  const oldEncoder = globalThis.AudioEncoder, oldData = globalThis.AudioData;
  class FakeData {
    data: Float32Array;
    constructor(init: AudioDataInit) { this.data = new Float32Array(init.data as Float32Array); }
    close() {}
  }
  class FakeEncoder {
    encodeQueueSize = 0;
    configure() {}
    encode(data: FakeData) { chunks.push(data.data.slice(0, data.data.length / 2)); }
    async flush() {}
    close() {}
  }
  Object.assign(globalThis, { AudioEncoder: FakeEncoder, AudioData: FakeData });
  try {
    const buffer = { length: 4801, numberOfChannels: 1, getChannelData: () => new Float32Array(4801).fill(1) } as unknown as AudioBuffer;
    await encodeSoundtrack(buffer, {} as never, 2, { beatSeconds: .10001, beatOffsetSeconds: 0 });
    const samples = Float32Array.from(chunks.flatMap(chunk => Array.from(chunk)));
    assert.equal(samples.length, 96000);
    for (let i = 1; i < 19; i++) assert.equal(samples[Math.round(i * 4800.48)], 0);
    assert.ok(samples[50000] > .5);
    assert.equal(samples[0], 0);
    assert.equal(samples.at(-1), 0);
  } finally {
    Object.assign(globalThis, { AudioEncoder: oldEncoder, AudioData: oldData });
  }
});
