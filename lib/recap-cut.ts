export interface RecapBeat {
  photoIds: string[];
  caption: string;
  seconds: number;
}

export interface RecapPresentation {
  style: 'minimal' | 'cinematic' | 'dynamic';
  text: 'none' | 'places' | 'story';
}

export interface RecapTheme {
  title: string;
  photoIds: string[];
}

export type RecapDirection = 'timeline' | 'subject' | 'place';

export type RecapGuidance =
  | { stage: 'themes'; direction: RecapDirection }
  | { stage: 'select'; direction: RecapDirection; theme: string; count: number; anchorIds: string[] }
  | { stage: 'compose'; direction: RecapDirection; theme: string; presentation: RecapPresentation };

export interface RecapCut {
  kind: 'journey' | 'moments' | 'focus';
  title: string;
  beats: RecapBeat[];
  presentation?: RecapPresentation;
  storyTheme?: string;
}

export interface RecapCutJob {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  cuts: RecapCut[] | null;
  themes?: RecapTheme[];
  selectedPhotoIds?: string[];
  error: string | null;
  analyzedCount: number;
  totalCount: number;
}

export const cutPhotoIds = (cut: RecapCut) => cut.beats.flatMap(beat => beat.photoIds);

export function validateRecapPresentation(value: unknown): RecapPresentation {
  const preferences = value as Partial<RecapPresentation> | null;
  if (!preferences ||
      (preferences.style !== 'minimal' && preferences.style !== 'cinematic' && preferences.style !== 'dynamic') ||
      (preferences.text !== 'none' && preferences.text !== 'places' && preferences.text !== 'story')) {
    throw new Error('Choose a visual style and on-screen text option.');
  }
  return { style: preferences.style, text: preferences.text };
}

export function validateRecapCut(value: unknown, allowedPhotoIds: readonly string[]): RecapCut {
  const cut = value as Partial<RecapCut> | null;
  if (!cut || (cut.kind !== 'journey' && cut.kind !== 'moments' && cut.kind !== 'focus') ||
      typeof cut.title !== 'string' || !cut.title.trim() || cut.title.trim().length > 100 ||
      !Array.isArray(cut.beats) || cut.beats.length < 1 || cut.beats.length > 12) {
    throw new Error('Invalid recap cut');
  }
  const allowed = new Set(allowedPhotoIds);
  const used = new Set<string>();
  const beats = cut.beats.map(beat => {
    if (!beat || !Array.isArray(beat.photoIds) || beat.photoIds.length < 1 ||
        beat.photoIds.length > (cut.kind === 'moments' ? 2 : 1) ||
        typeof beat.caption !== 'string' || beat.caption.trim().length > 80 ||
        !Number.isInteger(beat.seconds) || beat.seconds < 2 || beat.seconds > 6) {
      throw new Error('Invalid recap scene');
    }
    for (const id of beat.photoIds) {
      if (!allowed.has(id) || used.has(id)) throw new Error('Invalid recap photo');
      used.add(id);
    }
    return { photoIds: [...beat.photoIds], caption: beat.caption.trim(), seconds: beat.seconds };
  });
  const presentation = cut.presentation === undefined ? undefined : validateRecapPresentation(cut.presentation);
  const storyTheme = typeof cut.storyTheme === 'string' ? cut.storyTheme.trim().slice(0, 140) : '';
  return { kind: cut.kind, title: cut.title.trim(), beats, ...(storyTheme ? { storyTheme } : {}), ...(presentation ? { presentation } : {}) };
}

/** Keep the chosen edit after a photo is removed; new manual picks get a simple final scene. */
export function editRecapCut(cut: RecapCut | null | undefined, photoIds: readonly string[]): RecapCut | null {
  if (!cut || !photoIds.length) return null;
  const allowed = new Set(photoIds);
  const beats = cut.beats.flatMap(beat => {
    const ids = beat.photoIds.filter(id => allowed.has(id));
    if (!ids.length) return [];
    return [{ ...beat, photoIds: ids, caption: ids.length === beat.photoIds.length ? beat.caption : '' }];
  });
  const included = new Set(beats.flatMap(beat => beat.photoIds));
  for (const id of photoIds) {
    if (!included.has(id)) beats.push({ photoIds: [id], caption: '', seconds: 3 });
  }
  return beats.length <= 12 ? { ...cut, beats } : null;
}
