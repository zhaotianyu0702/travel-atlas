import { CITY_MUSIC } from "./recap-music-city";
import { LAND_MUSIC } from "./recap-music-land";
import { WATER_MUSIC } from "./recap-music-water";

/** Bundled, freely reusable instrumental recordings for recap videos. */
export type MusicProfile =
  | "coast" | "desert-drive" | "dive" | "nature"
  | "city" | "people" | "journey" | "quiet";
export type MusicStyle = "minimal" | "cinematic" | "dynamic";

export type RecapMusic = {
  id: string;
  title: string;
  mood: string;
  /** Ordered by fit, with the primary travel profile first. */
  profiles: MusicProfile[];
  styles?: MusicStyle[];
  src: string;
  /** Seconds between beats and the first beat's offset in the decoded recording. */
  beatSeconds: number;
  beatOffsetSeconds: number;
  /** Start of a representative passage for a short preview. */
  previewSeconds: number;
};

export const RECAP_MUSIC: RecapMusic[] = [
  {
    id: "osmotic-memory", title: "Osmotic Memory", mood: "Dreamy & reflective", profiles: ["quiet", "nature"], styles: ["minimal", "cinematic"],
    src: "/recap-audio/osmotic-memory.m4a", beatSeconds: 60 / 100,
    beatOffsetSeconds: 0.02, previewSeconds: 12,
  },
  {
    id: "a-small-fire-will-do", title: "A Small Fire Will Do", mood: "Warm & acoustic", profiles: ["nature", "people", "quiet"], styles: ["minimal"],
    src: "/recap-audio/a-small-fire-will-do.m4a", beatSeconds: 60 / 120,
    beatOffsetSeconds: 0, previewSeconds: 8,
  },
  {
    id: "joyfully", title: "Joyfully", mood: "Bright & energetic", profiles: ["people", "journey", "city"], styles: ["dynamic"],
    src: "/recap-audio/joyfully.m4a", beatSeconds: 60 / 170,
    beatOffsetSeconds: 0, previewSeconds: 24,
  },
  {
    id: "bossa-town", title: "Bossa Town", mood: "Relaxed & coastal",
    profiles: ["coast", "city"], styles: ["minimal", "cinematic"],
    src: "/recap-audio/bossa-town.m4a", beatSeconds: 60 / 100,
    beatOffsetSeconds: 0, previewSeconds: 20,
  },
  {
    id: "beach-stage", title: "Beach Stage", mood: "Sunny & playful",
    profiles: ["coast", "journey"], styles: ["dynamic"], src: "/recap-audio/beach-stage.m4a",
    beatSeconds: 60 / 128, beatOffsetSeconds: 0.26, previewSeconds: 12,
  },
  {
    id: "un-desert", title: "Un désert", mood: "Open road & guitar",
    profiles: ["desert-drive", "journey"], styles: ["cinematic"], src: "/recap-audio/un-desert.m4a",
    beatSeconds: 60 / 110, beatOffsetSeconds: 0.18, previewSeconds: 20,
  },
  {
    id: "drifting", title: "Drifting", mood: "Submerged & serene",
    profiles: ["dive", "quiet"], styles: ["minimal", "cinematic"], src: "/recap-audio/drifting.m4a",
    beatSeconds: 60 / 120, beatOffsetSeconds: 0, previewSeconds: 30,
  },
  {
    id: "forest", title: "Forest", mood: "Mellow & atmospheric",
    profiles: ["nature", "quiet"], styles: ["cinematic"], src: "/recap-audio/forest.m4a",
    beatSeconds: 60 / 110, beatOffsetSeconds: 0.02, previewSeconds: 30,
  },
  ...LAND_MUSIC,
  ...WATER_MUSIC,
  ...CITY_MUSIC,
];
