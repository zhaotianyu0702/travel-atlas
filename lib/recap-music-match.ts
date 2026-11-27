import { RECAP_MUSIC, type MusicProfile, type RecapMusic } from './recap-music-library';

/** Evidence must describe the selected photos only; omit unknown or unconfirmed details. */
export interface RecapMusicMatchInput {
  title?: string;
  theme?: string;
  photos?: readonly { id: string; description?: string; tags?: readonly string[]; place?: string }[];
  beats?: readonly { photoIds: readonly string[]; caption?: string }[];
  presentation?: { style?: string };
}

// Specific visual and activity terms, not country names or assumptions based on geography.
// Word boundaries avoid matching e.g. "diverse" as "dive". Chinese terms need no spaces.
const TERMS: Record<MusicProfile, RegExp> = {
  coast: /\b(?:coast(?:s|al|lines?)?|beach(?:es)?|shore(?:s|lines?)?|seaside|seascape|ocean|waves?|surf(?:ing)?|tide pools?)\b|海岸|海边|沙滩|沙灘|海灘|海滩|海浪|海滨|海濱|海洋/i,
  'desert-drive': /\b(?:deserts?|dunes?|sand dunes?|arid)\b|沙漠|沙丘|荒漠/i,
  dive: /\b(?:scuba|div(?:e|er|ers|ing)|snorkel(?:ling|ing)?|underwater|submerged|corals?|reefs?|sea turtles?|marine life|wreck dive)\b|潜水|潛水|浮潜|浮潛|水下|海底|珊瑚|海龟|海龜/i,
  nature: /\b(?:wildlife|animals?|forest|mountains?|hiking|hike|national park|trees?|birds?|safari|waterfall)\b|野生动物|野生動物|森林|山脉|山脈|徒步|瀑布|野生动物园/i,
  city: /\b(?:city|urban|street|architecture|buildings?|skyline|market|museum|town)\b|城市|街道|建筑|建築|博物馆|博物館|市集/i,
  people: /\b(?:people|friends?|family|portrait|together|celebration|wedding)\b|朋友|家人|人像|合影|聚会|聚會/i,
  journey: /\b(?:journey|travel|adventure|route|train|flight|airport|road trips?|roadtrips?|highways?|driving|overland)\b|旅程|旅行|旅途|冒险|冒險|路线|路線|火车|火車/i,
  quiet: /\b(?:quiet|calm|peaceful|stillness|reflection|reflective|solitude|sunset|sunrise)\b|安静|安靜|宁静|寧靜|平静|平靜|日落|日出/i,
};
const PROFILES = Object.keys(TERMS) as MusicProfile[];
type Scores = Record<MusicProfile, number>;
const empty = () => Object.fromEntries(PROFILES.map(profile => [profile, 0])) as Scores;

function hits(text: string | undefined): Scores {
  const result = empty();
  if (!text) return result;
  // Avoid counting a simple explicit absence as positive visual evidence.
  const clauses = text.normalize('NFKC').split(/[,.，。;；\n]+/);
  for (const profile of PROFILES) {
    result[profile] = clauses.some(clause => {
      const match = TERMS[profile].exec(clause);
      if (!match) return false;
      const before = clause.slice(Math.max(0, match.index - 16), match.index);
      return !/(?:\bno\s+|\bwithout\s+|\bnot\s+|没有|沒有|无|無)\s*$/i.test(before);
    }) ? 1 : 0;
  }
  return result;
}

// Different edits can use different songs when multiple recordings are equally suitable.
function tieBreak(key: string): number {
  let value = 2166136261;
  for (let i = 0; i < key.length; i++) value = Math.imul(value ^ key.charCodeAt(i), 16777619);
  return value >>> 0;
}

export function rankRecapMusic(input: RecapMusicMatchInput): RecapMusic[] {
  const score = empty();
  const add = (evidence: Scores, weight: number) => {
    for (const profile of PROFILES) score[profile] += evidence[profile] * weight;
  };
  add(hits(input.title), 4);
  add(hits(input.theme), 5);
  const photos = input.photos ?? [];
  // Each image contributes equally; repeated words in one caption cannot flood the score.
  for (const photo of photos) add(hits([photo.description, ...(photo.tags ?? []), photo.place].filter(Boolean).join(', ')), 6 / photos.length);
  const selected = new Set(photos.map(photo => photo.id));
  const beats = (input.beats ?? []).filter(beat => beat.photoIds.length > 0 && beat.photoIds.every(id => selected.has(id)));
  for (const beat of beats) add(hits(beat.caption), 2 / beats.length);
  // Style breaks close ties but cannot override a concrete subject on its own.
  const style = input.presentation?.style;
  if (style === 'dynamic') score.journey += .25;
  if (style === 'minimal') score.quiet += .3;
  if (style === 'cinematic') { score.quiet += .15; score.nature += .2; }
  const seed = JSON.stringify([input.title, input.theme, [...selected].sort(), style]);
  const hasEvidence = Object.values(score).some(value => value > 0);
  return RECAP_MUSIC.map(track => {
    const subjectFit = track.profiles.reduce((sum, profile, index) => sum + score[profile] * (index === 0 ? 1 : .3), 0);
    const styleFit = track.styles?.some(preferred => preferred === style) ? .65 : 0;
    return { track, fit: subjectFit + styleFit, tie: hasEvidence ? tieBreak(track.id + seed) : 0 };
  }).sort((a, b) => b.fit - a.fit || b.tie - a.tie).map(item => item.track);
}

export function recommendRecapMusic(input: RecapMusicMatchInput): RecapMusic {
  return rankRecapMusic(input)[0];
}
