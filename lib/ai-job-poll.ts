/** Poll a background job without creating it again when the connection is lost. */
export function pollAiJob<T extends { status: string }>(options: {
  load: () => Promise<T>;
  onUpdate: (value: T) => void;
  onWaiting: () => void;
  onError: (message: string) => void;
  initialDelay?: number;
  schedule?: (fn: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  const run = async () => {
    try {
      const value = await options.load();
      if (stopped) return;
      failures = 0;
      options.onUpdate(value);
      if (value.status !== 'queued' && value.status !== 'running') return;
      timer = schedule(run, 2000);
    } catch (error) {
      if (stopped) return;
      if (error instanceof AiPollError && !error.retryable) {
        options.onError(error.message);
        return;
      }
      options.onWaiting();
      failures++;
      timer = schedule(run, Math.min(30000, 2000 * 2 ** Math.min(failures, 4)));
    }
  };
  timer = schedule(run, options.initialDelay ?? 2000);
  return () => { stopped = true; cancel(timer); };
}

export class AiPollError extends Error {
  constructor(message: string, public readonly retryable: boolean) { super(message); }
}

export async function loadAiJob<T>(id: string): Promise<T> {
  const response = await fetch(`/api/ai/jobs/${encodeURIComponent(id)}`);
  const data = await response.json().catch(() => ({})) as {error?: unknown};
  if (!response.ok) throw new AiPollError(typeof data.error === 'string' ? data.error : `Request failed (${response.status})`, response.status === 408 || response.status === 429 || response.status >= 500);
  return data as T;
}

/** Failed checks are retryable; successful checks with no estimate are not failures. */
export function failedLocationPhotoIds(
  jobs: {id: string; photoId: string; status: string}[],
  photos: {id: string; confirmed: boolean; latitude: number | null; longitude: number | null}[],
): string[] {
  return Array.from(new Set(jobs.filter(j => j.status === 'failed'
    && photos.some(p => p.id === j.photoId && !p.confirmed && (p.latitude === null || p.longitude === null))
    && !jobs.some(other => other.photoId === j.photoId && other.id !== j.id && other.status !== 'failed')).map(j => j.photoId)));
}
