import { photoCaptureDate } from './photo-time';
import { validateRecapPresentation, type RecapCut, type RecapGuidance, type RecapTheme } from './recap-cut';
import type { Photo } from './types';

export function readRecapGuidance(body: Record<string, unknown>): RecapGuidance | undefined {
  if (body.stage === undefined) return undefined;
  const { stage, direction } = body;
  if (direction !== 'timeline' && direction !== 'subject' && direction !== 'place') throw Error('Choose a story direction.');
  if (stage === 'themes') return { stage, direction };
  const theme = typeof body.theme === 'string' ? body.theme.trim() : '';
  if (!theme || theme.length > 140) throw Error('Choose a theme.');
  if (stage === 'select') {
    const count = body.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 12) throw Error('Choose a photo count.');
    const anchorIds = body.anchorIds ?? [];
    if (!Array.isArray(anchorIds) || anchorIds.length > 3 || anchorIds.some(id => typeof id !== 'string') ||
        new Set(anchorIds).size !== anchorIds.length) throw Error('Invalid theme photos.');
    return { stage, direction, theme, count, anchorIds };
  }
  if (stage === 'compose') return { stage, direction, theme, presentation: validateRecapPresentation(body.presentation) };
  throw Error('Invalid recap step.');
}

export function recapCaptureOrder(photo: Photo) {
  const day = photoCaptureDate(photo);
  const wall = photo.timeSource === 'user' ? photo.capturedAt : photo.timeMetadata?.localDateTime ?? photo.capturedAt;
  return day ? wall?.slice(0, 19) || day : '';
}

export function recapThemeSample(photos: readonly Photo[]) {
  const ordered = [...photos].sort((a, b) => (recapCaptureOrder(a) || '~').localeCompare(recapCaptureOrder(b) || '~'));
  const days = new Map<string, Photo[]>();
  for (const photo of ordered) {
    const day = photoCaptureDate(photo);
    const members = days.get(day) ?? [];
    members.push(photo);
    days.set(day, members);
  }
  const limits = Math.min(32, ordered.length);
  const evenly = (items: readonly Photo[], n: number) => Array.from({ length: n }, (_, index) =>
    items[Math.floor((index + 0.5) * items.length / n)]);
  // Represent each day when possible, then use the remaining budget to span longer days.
  const groups = [...days.values()];
  if (groups.length >= limits) return evenly(groups.map(group => group[Math.floor(group.length / 2)]), limits);
  const counts = groups.map(() => 1);
  for (let i = groups.length; i < limits; i++) {
    let next = -1;
    let weight = 0;
    groups.forEach((group, index) => {
      const candidate = group.length / (counts[index] + 1);
      if (counts[index] < group.length && candidate > weight) {
        next = index;
        weight = candidate;
      }
    });
    counts[next]++;
  }
  return groups.flatMap((group, index) => evenly(group, counts[index]));
}

export function validateRecapThemes(raw: unknown, knownIds: readonly string[]): RecapTheme[] {
  const list = (raw as { themes?: unknown })?.themes;
  if (!Array.isArray(list) || !list.length || list.length > 3) throw Error('Invalid theme suggestions.');
  const titles = new Set<string>();
  return list.map(entry => {
    const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
    const ids = entry?.photoIds;
    if (!title || title.length > 100 || titles.has(title.toLowerCase()) ||
        !Array.isArray(ids) || ids.length < 1 || ids.length > 3 ||
        new Set(ids).size !== ids.length || ids.some(id => !knownIds.includes(id))) throw Error('Invalid theme evidence.');
    titles.add(title.toLowerCase());
    return { title, photoIds: ids };
  });
}

export function validateSelectedRecapPhotos(raw: unknown, photos: readonly string[], count: number) {
  const ids = (raw as { selectedPhotoIds?: unknown })?.selectedPhotoIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > count || new Set(ids).size !== ids.length ||
      ids.some(id => !photos.includes(id))) throw Error('Invalid suggested photos.');
  return ids as string[];
}

export function applyRecapPresentation(
  cut: RecapCut,
  guidance: Extract<RecapGuidance, { stage: 'compose' }>,
  photos: readonly Photo[],
  places: Readonly<Record<string, string>>,
): RecapCut {
  const byId = new Map(photos.map(photo => [photo.id, photo]));
  const { presentation } = guidance;
  const beats = [...cut.beats];
  if (guidance.direction === 'timeline') {
    const key = (id: string) => recapCaptureOrder(byId.get(id)!) || '~';
    beats.sort((a, b) => key(a.photoIds[0]).localeCompare(key(b.photoIds[0])));
  }
  return {
    ...cut,
    storyTheme: guidance.theme,
    presentation,
    beats: beats.map(beat => {
      if (presentation.text === 'story') return beat;
      if (presentation.text === 'none') return { ...beat, caption: '' };
      const labels = [...new Set(beat.photoIds.map(id => places[id]).filter(Boolean))];
      const place = labels.length === 1 ? labels[0] : '';
      if (!place || place.length > 80) return { ...beat, caption: '' };
      return { ...beat, caption: place };
    }),
  };
}
