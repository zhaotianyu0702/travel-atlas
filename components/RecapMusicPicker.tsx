"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Pause, Play, X } from "lucide-react";
import type { MusicProfile, RecapMusic } from "@/lib/recap-music-library";

type Props = {
  tracks: RecapMusic[];
  initialChoice: string | null;
  onClose: () => void;
  onExport: (musicId: string | null) => void;
};

const scenes: Record<MusicProfile, string> = {
  coast: "Coast", "desert-drive": "Desert drives", dive: "Diving", nature: "Nature",
  city: "City", people: "People", journey: "On the road", quiet: "Quiet moments",
};
const searchable = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

export default function RecapMusicPicker({ tracks, initialChoice, onClose, onExport }: Props) {
  const recommended = tracks[0];
  const [query, setQuery] = useState("");
  const [scene, setScene] = useState("");
  const [choice, setChoice] = useState(initialChoice);
  const selected = choice ?? recommended.id;
  const selectedTrack = tracks.find(track => track.id === selected) ?? recommended;
  const search = searchable(query.trim());
  const matches = tracks.filter(track => (!scene || track.profiles.some(profile => profile === scene)) &&
    searchable([track.title, track.mood, ...track.profiles.map(profile => scenes[profile])].join(" ")).includes(search));
  const [playing, setPlaying] = useState("");
  const [error, setError] = useState("");
  const panel = useRef<HTMLElement>(null);
  const player = useRef<HTMLAudioElement | null>(null);

  const release = () => {
    const audio = player.current;
    player.current = null;
    if (!audio) return;
    audio.onended = audio.ontimeupdate = audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
  useEffect(() => {
    panel.current?.querySelector<HTMLInputElement>("input:checked")?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "nearest" });
    return release;
  }, []);
  const stopPreview = () => { release(); setPlaying(""); setError(""); };
  const select = (id: string) => {
    stopPreview();
    setChoice(id === recommended.id ? null : id);
  };
  const preview = async (track: RecapMusic) => {
    select(track.id);
    if (playing === track.id) return;
    const audio = new Audio(track.src);
    player.current = audio;
    audio.currentTime = track.previewSeconds;
    const stop = () => {
      if (player.current === audio) { release(); setPlaying(""); }
    };
    const failed = () => {
      if (player.current === audio) { stop(); setError("Preview unavailable. Try again."); }
    };
    audio.onended = stop;
    audio.onerror = failed;
    audio.ontimeupdate = () => { if (audio.currentTime >= track.previewSeconds + 12) stop(); };
    setPlaying(track.id);
    try { await audio.play(); } catch { failed(); }
  };

  return <section ref={panel} className="recap-music" aria-label="Video soundtrack" onKeyDown={e => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
  }}>
    <div className="recap-music-heading"><h3>Soundtrack</h3><button type="button" onClick={onClose} aria-label="Close soundtrack"><X size={19}/></button></div>
    <div className="recap-music-filters">
      <input type="search" aria-label="Search music" placeholder="Search music" value={query}
        onChange={event => { stopPreview(); setQuery(event.target.value); }} />
      <select aria-label="Music scene" value={scene} onChange={event => { stopPreview(); setScene(event.target.value); }}>
        <option value="">All scenes</option>
        {Object.entries(scenes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
    </div>
    <p className="recap-music-count" role="status">{matches.length} {matches.length === 1 ? "track" : "tracks"}</p>
    <div role="radiogroup" className="recap-music-options" aria-label="Choose music">{matches.map(track =>
      <div key={track.id} className="recap-music-track" data-selected={selected === track.id}>
        <label><input type="radio" name="recap-soundtrack" checked={selected === track.id} onChange={() => select(track.id)} />
          <span><strong>{track.title}</strong><small>{track.id === recommended.id && "Recommended · "}{track.mood}</small></span>
        </label>
        <button type="button" onClick={() => void preview(track)} aria-label={(playing === track.id ? "Pause " : "Preview ") + track.title}>
          {playing === track.id ? <Pause size={17}/> : <Play size={17}/>}
        </button>
      </div>
    )}</div>
    {!matches.length && <button className="text-button" type="button" onClick={() => { setQuery(""); setScene(""); }}>Clear filters</button>}
    {error && <p role="alert">{error}</p>}
    <button className="primary" type="button" onClick={() => {
      release();
      onExport(choice);
    }}><Download size={18}/><span>Export video<small>{selectedTrack.title}</small></span></button>
  </section>;
}
