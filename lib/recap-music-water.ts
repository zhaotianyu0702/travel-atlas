import type { RecapMusic } from './recap-music-library';

/** CC0 instrumental recordings selected for coastal, underwater, and reflective recaps. */
export const WATER_MUSIC: RecapMusic[] = [
  { id: 'coast-bossa-nova', title: 'Bossa Nova', mood: 'Easygoing & playful', profiles: ['coast', 'city'], styles: ['minimal'], src: '/recap-audio/coast-bossa-nova.m4a', beatSeconds: 60 / 129, beatOffsetSeconds: 0.28, previewSeconds: 12 },
  { id: 'coast-buy-something', title: 'Buy Something!', mood: 'Sunny & jazzy', profiles: ['coast', 'city'], styles: ['minimal'], src: '/recap-audio/coast-buy-something.m4a', beatSeconds: 60 / 80.75, beatOffsetSeconds: 0.4, previewSeconds: 12 },
  { id: 'dive-underwater-theme-ii', title: 'Underwater Theme II', mood: 'Calm & aquatic', profiles: ['dive', 'quiet'], styles: ['minimal', 'cinematic'], src: '/recap-audio/dive-underwater-theme-ii.m4a', beatSeconds: 60 / 99.385, beatOffsetSeconds: 0.085, previewSeconds: 12 },
  { id: 'dive-exploration-theme', title: 'Exploration Theme', mood: 'Floating & curious', profiles: ['dive', 'journey'], styles: ['cinematic'], src: '/recap-audio/dive-exploration-theme.m4a', beatSeconds: 60 / 99.38, beatOffsetSeconds: 0.21, previewSeconds: 12 },
  { id: 'dive-aurora', title: 'Aurora', mood: 'Soft & submerged', profiles: ['dive', 'quiet'], styles: ['minimal'], src: '/recap-audio/dive-aurora.m4a', beatSeconds: 60 / 117.45, beatOffsetSeconds: 0.465, previewSeconds: 12 },
  { id: 'dive-iridescent-deep', title: 'Iridescent Deep', mood: 'Dreamy & expansive', profiles: ['dive', 'quiet'], styles: ['cinematic', 'minimal'], src: '/recap-audio/dive-iridescent-deep.m4a', beatSeconds: 60 / 71.775, beatOffsetSeconds: 0.81, previewSeconds: 12 },
  { id: 'quiet-safe-space', title: 'Safe Space', mood: 'Still & reassuring', profiles: ['quiet', 'dive'], styles: ['minimal'], src: '/recap-audio/quiet-safe-space.m4a', beatSeconds: 60 / 100, beatOffsetSeconds: 0.05, previewSeconds: 12 },
  { id: 'quiet-yoiyami-core', title: 'Yoiyami Core Theme', mood: 'Serene & reflective', profiles: ['quiet', 'nature'], styles: ['cinematic', 'minimal'], src: '/recap-audio/quiet-yoiyami-core.m4a', beatSeconds: 60 / 129.2, beatOffsetSeconds: 0.225, previewSeconds: 12 },
  { id: 'quiet-forget-me-not', title: 'Forget Me Not', mood: 'Gentle & nostalgic', profiles: ['quiet', 'nature'], styles: ['minimal'], src: '/recap-audio/quiet-forget-me-not.m4a', beatSeconds: 60 / 99.38, beatOffsetSeconds: 0.365, previewSeconds: 12 },
  { id: 'quiet-emotional-piano', title: 'Emotional Piano', mood: 'Tender & reflective', profiles: ['quiet', 'people'], styles: ['minimal', 'cinematic'], src: '/recap-audio/quiet-emotional-piano.m4a', beatSeconds: 60 / 99.38, beatOffsetSeconds: 0.17, previewSeconds: 12 },
  { id: 'quiet-desert-pink', title: 'Desert Pink and Navy Blue', mood: 'Spacious & contemplative', profiles: ['quiet', 'desert-drive'], styles: ['minimal', 'cinematic'], src: '/recap-audio/quiet-desert-pink.m4a', beatSeconds: 60 / 90, beatOffsetSeconds: 0.075, previewSeconds: 12 },
];
