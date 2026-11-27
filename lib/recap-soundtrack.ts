import type { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { RECAP_MUSIC } from "./recap-music-library";

export const SOUNDTRACK_BPM = 100;
export const SOUNDTRACK_BEAT_SECONDS = 60 / SOUNDTRACK_BPM;
// Offset of the first audible beat in the bundled recording, in seconds.
export const SOUNDTRACK_BEAT_OFFSET = .02;
export const SOUNDTRACK_SAMPLE_RATE = 48_000;
export const SOUNDTRACK_CHANNELS = 2;
const AUDIO_CONFIG: AudioEncoderConfig = {
  codec: "mp4a.40.2", sampleRate: SOUNDTRACK_SAMPLE_RATE,
  numberOfChannels: SOUNDTRACK_CHANNELS, bitrate: 160_000,
};

type TrackTiming = { beatSeconds: number; beatOffsetSeconds: number };

/** Round each absolute beat position once, avoiding accumulated frame rounding. */
export function soundtrackTimeline(durations: number[], fps: number, bookendSeconds: number, track: TrackTiming = { beatSeconds: SOUNDTRACK_BEAT_SECONDS, beatOffsetSeconds: SOUNDTRACK_BEAT_OFFSET }) {
  const beat = track.beatSeconds;
  if (!Number.isFinite(beat) || beat <= 0 || !Number.isFinite(track.beatOffsetSeconds) || !Number.isFinite(fps) || fps <= 0) throw new Error("Invalid soundtrack beat timing.");
  const frameAt = (n: number) => Math.round((track.beatOffsetSeconds + n * beat) * fps);
  let beatIndex = Math.max(0, Math.round((bookendSeconds - track.beatOffsetSeconds) / beat));
  while (frameAt(beatIndex) < 1) beatIndex++;
  const first = frameAt(beatIndex), starts: number[] = [], lengths: number[] = [];
  for (const seconds of durations) {
    const start = frameAt(beatIndex);
    starts.push(start);
    beatIndex += Math.max(1, Math.round(seconds / beat));
    lengths.push(frameAt(beatIndex) - start);
  }
  beatIndex += Math.max(1, Math.round(bookendSeconds / beat));
  return { first, starts, durations: lengths, totalFrames: frameAt(beatIndex) };
}

export function getSoundtrack(id?: string) {
  const track = id === undefined ? RECAP_MUSIC[0] : RECAP_MUSIC.find(item => item.id === id);
  if (!track) throw new Error("The selected soundtrack is unavailable.");
  return track;
}

/** Called only when the user chooses MP4. Never fetch the soundtrack for PNG or the player. */
export async function loadSoundtrack(track = getSoundtrack()): Promise<AudioBuffer> {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined" || typeof AudioContext === "undefined")
    throw new Error("MP4 with music requires a browser with WebCodecs AAC support. Try a recent Chrome or Edge.");
  if (!(await AudioEncoder.isConfigSupported(AUDIO_CONFIG)).supported)
    throw new Error("This browser cannot encode AAC audio for MP4. Try a recent Chrome or Edge.");
  const response = await fetch(track.src);
  if (!response.ok) throw new Error("Could not load the recap soundtrack. Please retry.");
  const context = new AudioContext({ sampleRate: SOUNDTRACK_SAMPLE_RATE });
  try {
    const audio = await context.decodeAudioData(await response.arrayBuffer());
    if (audio.sampleRate !== SOUNDTRACK_SAMPLE_RATE || audio.length < SOUNDTRACK_SAMPLE_RATE)
      throw new Error("The recap soundtrack could not be prepared at the required sample rate.");
    return audio;
  } finally { await context.close(); }
}

/** Encode in bounded blocks, fading the ends and loop seams on the beat grid. */
export async function encodeSoundtrack(buffer: AudioBuffer, muxer: Muxer<ArrayBufferTarget>, duration: number, track: TrackTiming = getSoundtrack()) {
  const rate = SOUNDTRACK_SAMPLE_RATE, totalSamples = Math.round(duration * rate);
  const beatSamples = track.beatSeconds * rate;
  if (!Number.isFinite(beatSamples) || beatSamples <= 0) throw new Error("Invalid soundtrack beat timing.");
  let loopBeats = Math.floor(buffer.length / beatSamples);
  while (loopBeats > 0 && Math.ceil(loopBeats * beatSamples) > buffer.length) loopBeats--;
  if (!loopBeats) throw new Error("The recap soundtrack is too short to loop.");
  const loopSamples = loopBeats * beatSamples;
  const channels = [buffer.getChannelData(0), buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1))];
  const seam = Math.min(Math.round(rate * .08), Math.floor(loopSamples / 4));
  const fade = Math.round(rate * Math.min(1.2, duration / 2));
  let failure: Error | null = null;
  const encoder = new AudioEncoder({ output: (chunk, metadata) => muxer.addAudioChunk(chunk, metadata), error: error => { failure = error; } });
  try {
    encoder.configure(AUDIO_CONFIG);
    for (let start = 0; start < totalSamples; start += 4096) {
      if (failure) throw failure;
      const count = Math.min(4096, totalSamples - start), data = new Float32Array(count * SOUNDTRACK_CHANNELS);
      for (let channel = 0; channel < SOUNDTRACK_CHANNELS; channel++) {
        const input = channels[channel];
        for (let i = 0; i < count; i++) {
          const t = start + i;
          // Round each absolute loop boundary independently to keep beat phase stable.
          let loop = Math.floor(t / loopSamples);
          if (t >= Math.round((loop + 1) * loopSamples)) loop++;
          const loopStart = Math.round(loop * loopSamples);
          const loopEnd = Math.round((loop + 1) * loopSamples);
          const pos = t - loopStart, length = loopEnd - loopStart;
          let sample = input[pos];
          // A short dip at a loop boundary avoids a click without shifting beat phase.
          if (loop > 0 && pos < seam) sample *= pos / seam;
          if (pos >= length - seam && loopEnd < totalSamples) sample *= (length - pos) / seam;
          const gain = Math.min(1, t / fade, (totalSamples - 1 - t) / fade);
          data[channel * count + i] = sample * Math.max(0, gain) * .8;
        }
      }
      const frame = new AudioData({ format: "f32-planar", sampleRate: rate, numberOfFrames: count, numberOfChannels: SOUNDTRACK_CHANNELS, timestamp: Math.round(start * 1_000_000 / rate), data });
      try { encoder.encode(frame); } finally { frame.close(); }
      if (encoder.encodeQueueSize > 12) await encoder.flush();
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally { encoder.close(); }
}
