import { RECAP_MUSIC } from "./recap-music-library";
import type { RecapPresentation } from "./recap-cut";

export function readMusicChoice(recapId: string, style?: RecapPresentation["style"]): string | null {
  if (!recapId) return null;
  try {
    let id = localStorage.getItem("atlas:chosen-video-music:" + recapId);
    if (id === null) {
      // Older exports also saved automatic selections. Migrate only identifiable manual choices.
      const legacy = localStorage.getItem("atlas:video-music:" + recapId);
      const oldDefault = style === "dynamic" ? "joyfully" : style === "minimal" ? "a-small-fire-will-do" : "osmotic-memory";
      if (legacy !== oldDefault) id = legacy;
    }
    return RECAP_MUSIC.some(track => track.id === id) ? id : null;
  } catch { return null; }
}

export function rememberMusicChoice(recapId: string, choice: string | null) {
  try { localStorage.setItem("atlas:chosen-video-music:" + recapId, choice ?? ""); } catch {}
}
