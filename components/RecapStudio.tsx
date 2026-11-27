"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Music2,
  Maximize2,
  Pause,
  Play,
  Plus,
  Save,
  X,
} from "lucide-react";
import type { Photo, Trip } from "@/lib/types";
import { buildRecapScene, recapFrameCopy, type RecapScene } from "@/lib/recap-story";
import { cutPhotoIds, type RecapCut } from "@/lib/recap-cut";
import RecapGenerator from "./RecapGenerator";
import { rankRecapMusic } from "@/lib/recap-music-match";
import { RECAP_MUSIC } from "@/lib/recap-music-library";
import { readMusicChoice } from "@/lib/recap-music-preference";
import RecapMusicPicker from "./RecapMusicPicker";
import { buildRecapSceneMap, drawRecapMapBase, drawRecapMapRoute } from "@/lib/recap-map";
import "./recap-studio.css";

type Props = {
  scene: RecapScene;
  available: Photo[];
  trips: Trip[];
  tripId: string;
  busy: boolean;
  progress: number | null;
  autoStart?: boolean;
  onCancelNew: () => void;
  onTitle: (title: string) => void;
  onTrip: (id: string) => void;
  onPhotos: (ids: string[]) => void;
  onActive: (id: string) => void;
  onCut: (cut: RecapCut) => void;
  focusedPhotoId?: string;
  onSave: () => void;
  onExport: (format: "html" | "png" | "mp4", musicId?: string, manualMusicId?: string | null) => void;
};

function RouteSketch({ scene, active }: { scene: RecapScene; active: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const previous = useRef<number | null>(null);
  const mapKey = JSON.stringify([scene.mapContext, scene.photos.map(photo => photo.point)]);
  const map = useMemo(() => buildRecapSceneMap(scene, 400, 204), [mapKey]);
  const base = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const layer = document.createElement("canvas");
    layer.width = 800; layer.height = 408;
    const ctx = layer.getContext("2d");
    if (ctx) { ctx.scale(2, 2); drawRecapMapBase(ctx, scene.recap.cut?.presentation ? { ...map, labels: [] } : map); }
    base.current = layer;
    previous.current = null;
  }, [map, scene.recap.cut?.presentation]);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !base.current) return;
    const start = previous.current ?? active;
    previous.current = active;
    const animate = !matchMedia("(prefers-reduced-motion: reduce)").matches && start !== active;
    const started = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      const t = animate ? Math.min(1, (now - started) / 700) : 1;
      const eased = t * t * (3 - 2 * t);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(base.current!, 0, 0);
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      drawRecapMapRoute(ctx, map, start + (active - start) * eased);
      if (t < 1) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [map, active, scene.recap.cut?.presentation]);
  return <canvas ref={canvas} width={800} height={408} style={{ aspectRatio: "400 / 204" }} role="img" aria-label={map.contextOnly ? (scene.mapContext ? "Trip area on a geographic map" : "World map") : "Trip route on a geographic map"} />;
}

export default function RecapStudio(props: Props) {
  const {
    scene: draft,
    available,
    trips,
    tripId,
    busy,
    progress,
    onTitle,
    onTrip,
    onPhotos,
    onSave,
    onExport,
  } = props;
  const [wizardOpen, setWizardOpen] = useState(!!props.autoStart);
  const [preview, setPreview] = useState<RecapCut | null>(null);
  const scene = useMemo(() => preview
    ? buildRecapScene({ ...draft.recap, title: preview.title, cut: preview, photoIds: cutPhotoIds(preview) }, available, "preview")
    : draft, [preview, draft, available]);
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [theatre, setTheatre] = useState(false);
  const [picking, setPicking] = useState(false);
  const [downloads, setDownloads] = useState(false);
  const [musicOpen, setMusicOpen] = useState(false);
  const handleWizardOpen = useCallback((open: boolean) => {
    setWizardOpen(open);
    if (open) setMusicOpen(false);
  }, []);
  const exportButton = useRef<HTMLButtonElement>(null);
  const closeMusic = () => { setMusicOpen(false); exportButton.current?.focus(); };
  const mapSelection = useRef(false);
  const theatreRef = useRef<HTMLDivElement>(null);
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");
  const [imageAttempt, setImageAttempt] = useState(0);
  const onActive = useRef(props.onActive);
  onActive.current = props.onActive;
  const selectionKey = scene.photos.map((photo) => photo.id).join("|");
  const selectedIds = new Set(draft.photos.map(photo => photo.id));
  const beats = scene.beats.length ? scene.beats : scene.photos.map(photo => ({ photoIds: [photo.id], caption: "", seconds: 3 }));
  const beatIndex = Math.max(0, beats.findIndex(beat => beat.photoIds.includes(scene.photos[active]?.id)));
  const beat = beats[beatIndex];
  const presentation = scene.recap.cut?.presentation;
  const [manualMusicId, setManualMusicId] = useState<string | null>(null);
  const rankedMusic = useMemo(() => {
    if (!downloads && !musicOpen) return RECAP_MUSIC;
    const byId = new Map(available.map(photo => [photo.id, photo]));
    return rankRecapMusic({
      title: draft.recap.title,
      theme: draft.recap.cut?.storyTheme || (draft.recap.cut?.title !== draft.recap.title ? draft.recap.cut?.title : undefined),
      photos: draft.photos.map(photo => {
        const original = byId.get(photo.id);
        return { id: photo.id, description: original?.recapVisualDescription, tags: original?.notes ? [original.notes] : [],
          place: photo.label };
      }),
      beats: draft.beats,
      presentation: draft.recap.cut?.presentation,
    });
  }, [draft, available, downloads, musicOpen]);
  const recommended = rankedMusic[0];
  const soundtrack = RECAP_MUSIC.find(track => track.id === manualMusicId) ?? recommended;
  const exportVideo = (choice: string | null) => {
    setDownloads(false); closeMusic(); setPlaying(false);
    onExport("mp4", choice ?? recommended.id, choice);
  };
  const copy = recapFrameCopy(scene, active, beat);
  const cutAtLimit = draft.beats.length >= 12;
  const pair = beat?.photoIds.length === 2 ? beat.photoIds.map(id => scene.photos.find(photo => photo.id === id)!) : [];
  const beatKey = beat?.photoIds.join("|") ?? "";
  const nextBeat = (direction: number) => {
    const index = Math.max(0, Math.min(beats.length - 1, beatIndex + direction));
    setActive(scene.photos.findIndex(photo => photo.id === beats[index]?.photoIds[0]));
  };
  const closeTheatre = () => { setTheatre(false); setPlaying(false); setPreview(null); };
  const theatreActions = useRef({ nextBeat, closeTheatre });
  theatreActions.current = { nextBeat, closeTheatre };
  const photo =
    scene.photos[Math.min(active, Math.max(0, scene.photos.length - 1))];

  useEffect(() => {
    setActive(0);
    setPlaying(false);
  }, [selectionKey]);
  useEffect(() => {
    const index = scene.photos.findIndex(
      (item) => item.id === props.focusedPhotoId,
    );
    if (!preview && index >= 0 && index !== active) {
      mapSelection.current = true;
      setActive(index);
      setPlaying(false);
    }
  }, [props.focusedPhotoId]);
  useEffect(() => {
    if (mapSelection.current) {
      mapSelection.current = false;
      return;
    }
    if (photo && !preview) onActive.current(photo.id);
  }, [photo?.id, preview]);
  useEffect(() => {
    if (!playing || imageState !== "ready" || !beat) return;
    const timer = window.setTimeout(() => {
      if (beatIndex === beats.length - 1) setPlaying(false);
      else nextBeat(1);
    }, beat.seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [playing, beatKey, beatIndex, beat?.seconds, beats.length, imageState]);
  useEffect(() => {
    if (!beat) return;
    let alive = true;
    setImageState("loading");
    const timer = window.setTimeout(() => {
      if (alive) { setImageState("error"); setPlaying(false); }
    }, 30_000);
    const decode = beat.photoIds.map(id => {
      const image = new Image();
      image.src = scene.photos.find(item => item.id === id)!.src;
      return image.decode();
    });
    void Promise.all(decode).then(() => { if (alive) setImageState("ready"); }, () => {
      if (alive) { setImageState("error"); setPlaying(false); }
    }).finally(() => window.clearTimeout(timer));
    return () => { alive = false; window.clearTimeout(timer); };
  }, [beatKey, imageAttempt]);
  useEffect(() => {
    if (!downloads) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".recap-download-wrap")) setDownloads(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setDownloads(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [downloads]);
  useEffect(() => {
    for (const id of beats[beatIndex + 1]?.photoIds ?? []) {
      const next = scene.photos.find(item => item.id === id);
      if (next) new Image().src = next.src;
    }
  }, [beatKey, selectionKey]);
  useEffect(() => {
    if (!theatre) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const container = theatreRef.current;
    container?.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Tab" && container) {
        const controls = Array.from(container.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (event.key === "Escape") {
        theatreActions.current.closeTheatre();
      }
      if (event.key === "ArrowRight") { event.preventDefault(); setPlaying(false);
        theatreActions.current.nextBeat(1); }
      if (event.key === "ArrowLeft") { event.preventDefault(); setPlaying(false);
        theatreActions.current.nextBeat(-1); }
      if (event.key === " " && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        setPlaying((value) => !value);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previousFocus?.focus(); };
  }, [theatre]);

  const step = (direction: number) => {
    setPlaying(false);
    nextBeat(direction);
  };
  const story = (full: boolean) =>
    photo && (
      <div className={`recap-stage ${full ? "recap-stage-full" : ""} ${scene.recap.cut?.kind === "focus" ? "recap-stage-focus" : ""} ${presentation ? `recap-preset-${presentation.style}` : ""} ${photo.width > 0 && photo.height > 0 && photo.width / photo.height < 0.67 ? "recap-extreme-portrait" : ""}`}>
        <div
          className="recap-photo-backdrop"
          style={{ backgroundImage: `url("${photo.src}")` }}
        />
        {pair.length ? <div className={playing ? "recap-stage-pair moving" : "recap-stage-pair"} key={beatKey}>
          {pair.map(item => <img key={item.id} src={item.src} alt={item.label || "Trip photograph"} />)}
        </div> : <img
          key={`${photo.id}-${imageAttempt}`}
          className={playing ? "recap-stage-photo moving" : "recap-stage-photo"}
          src={photo.src}
          alt={photo.label || "Trip photograph"}
        />}
        <div className="recap-stage-shade" />
        {imageState !== "ready" && <div className="recap-image-status" role="status">
          {imageState === "loading" ? <LoaderCircle className="spinning" aria-label="Loading photo" /> : <><span>Photo unavailable</span><button type="button" aria-label="Retry photo" onClick={() => { setImageState("loading"); setImageAttempt(value => value + 1); }}><LoaderCircle /></button></>}
        </div>}
        {(copy.date || copy.headline || copy.place) && <div className="recap-stage-heading">
          {copy.date && <span>{copy.date}</span>}
          {copy.headline && <h2>{copy.headline}</h2>}
          {copy.place && <p>{copy.place}</p>}
        </div>}
        <div className="recap-route-sketch">
          <RouteSketch scene={scene} active={active} />
        </div>
        <div className="recap-stage-controls">
          <button
            type="button"
            aria-label={playing ? "Pause recap" : "Play recap"}
            onClick={() => {
              if (!playing && beatIndex === beats.length - 1) setActive(0);
              setMusicOpen(false);
              setPlaying((value) => !value);
            }}
          >
            {playing ? <Pause /> : <Play />}
          </button>
          <div className="recap-progress" aria-label="Recap photos">
            {beats.map((item, index) => (
              <button
                type="button"
                key={item.photoIds[0]}
                className={index === beatIndex ? "active" : ""}
                aria-label={`Show ${scene.beats.length ? "scene" : "photo"} ${index + 1}`}
                aria-current={index === beatIndex ? "step" : undefined}
                onClick={() => {
                  setActive(scene.photos.findIndex(photo => photo.id === item.photoIds[0]));
                  setPlaying(false);
                }}
              >
                <span />
              </button>
            ))}
          </div>
          {!full && (
            <button
              type="button"
              aria-label="Expand recap"
              onClick={() => { setMusicOpen(false); setTheatre(true); }}
            >
              <Maximize2 />
            </button>
          )}
        </div>
        {full && (
          <>
            <button
              type="button"
              className="recap-close-stage"
              aria-label="Close preview"
              onClick={closeTheatre}
            >
              <X />
            </button>
            <button
              type="button"
              className="recap-step previous"
              aria-label="Previous photo"
              disabled={!beatIndex}
              onClick={() => step(-1)}
            >
              <ChevronLeft />
            </button>
            <button
              type="button"
              className="recap-step next"
              aria-label="Next photo"
              disabled={beatIndex === beats.length - 1}
              onClick={() => step(1)}
            >
              <ChevronRight />
            </button>
          </>
        )}
      </div>
    );

  return (
    <section className="recap-studio" aria-label="Recap editor">
      <label className="recap-trip-select">
        <span>Trip</span>
        <select
          disabled={busy}
          aria-label="Recap trip"
          value={tripId}
          onChange={(event) => onTrip(event.target.value)}
        >
          <option value="">Choose a trip</option>
          {trips.map((trip) => (
            <option key={trip.id} value={trip.id}>
              {trip.title}
            </option>
          ))}
        </select>
      </label>
      <RecapGenerator key={`${tripId}:${draft.recap.id}`} tripId={tripId} photos={available} disabled={busy}
        autoStart={props.autoStart} onCancel={props.onCancelNew} onOpenChange={handleWizardOpen} onPreview={cut => { setPreview(cut); setActive(0); setPlaying(false); setTheatre(true); }} onApply={cut => { props.onCut(cut); setActive(0); setPlaying(false); }} />
      {!wizardOpen && (photo ? (
        <>
          <input
            readOnly={busy}
            className="recap-title-input"
            aria-label="Recap title"
            value={scene.recap.title}
            placeholder="Name your recap"
            onChange={(event) => onTitle(event.target.value)}
          />
          {!preview && story(false)}
          <div className="recap-main-actions">
            <button
              type="button"
              className="recap-watch"
              onClick={() => {
                setTheatre(true);
                setActive(0);
                setMusicOpen(false);
                setPlaying(true);
              }}
            >
              <Play size={20} /> Play
            </button>
            <div className="recap-download-wrap">
              <button
                type="button"
                ref={exportButton}
                className="recap-download"
                aria-expanded={downloads || musicOpen}
                aria-label="Export recap"
                disabled={busy}
                onClick={() => { if (musicOpen) closeMusic();
                  else { setManualMusicId(readMusicChoice(draft.recap.id, presentation?.style)); setDownloads(value => !value); } }}
              >
                {busy ? (
                  <LoaderCircle className="spinning" size={20} />
                ) : (
                  <Download size={20} />
                )}{" "}
                {progress !== null
                  ? `${Math.round(progress * 100)}%`
                  : "Export"}
              </button>
              {downloads && (
                <div className="recap-download-menu" aria-label="Export format">
                  <div className="recap-video-option">
                    <button type="button" className="recap-video-direct" disabled={busy} onClick={() => exportVideo(manualMusicId)}>
                      <Play size={19}/><span><strong>Video · 1080p</strong><small>{soundtrack.title}</small></span>
                    </button>
                    <button type="button" className="recap-change-music" aria-label="Change music" title="Change music"
                      onClick={() => { setDownloads(false); setPlaying(false); setMusicOpen(true); }}><Music2 size={19}/><span>Change</span></button>
                  </div>
                  {([["html", "Photo story", Film], ["png", "Cover image", ImageIcon]] as const).map(([format, label, Icon]) =>
                    <button type="button" key={format} disabled={busy} onClick={() => { setDownloads(false); setPlaying(false); onExport(format); }}>
                      <Icon size={19}/>{label}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          {musicOpen && !playing && !theatre && <RecapMusicPicker tracks={rankedMusic} initialChoice={manualMusicId}
            onClose={closeMusic} onExport={exportVideo} />}
          <div className="recap-strip-heading">
            <span>{scene.photos.length} photos</span>
            <div>
              <button
                type="button"
                disabled={busy}
                aria-label="Choose recap photos"
                onClick={() => setPicking((value) => !value)}
              >
                <Plus size={19} />
              </button>
              <button
                type="button"
                disabled={busy || !scene.recap.title.trim()}
                aria-label="Save recap"
                onClick={onSave}
              >
                <Save size={19} />
              </button>
            </div>
          </div>
          <div className="recap-photo-strip">
            {draft.photos.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={active === index ? "active" : ""}
                data-timeline-photo={item.id}
                aria-label={`Preview photo ${index + 1}`}
                onClick={() => {
                  setActive(index);
                  setPlaying(false);
                }}
              >
                <img src={item.src} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        </>
      ) : (
        <button
          type="button"
          className="recap-empty-picker"
          onClick={() => setPicking(true)}
        >
          <Plus size={32} />
          <span>Choose photos</span>
        </button>
      ))}
      {!wizardOpen && picking && (
        <div className="recap-picker">
          <div className="recap-strip-heading">
            <strong>Photos</strong>
            <button
              type="button"
              aria-label="Close photo selection"
              onClick={() => setPicking(false)}
            >
              <X size={20} />
            </button>
          </div>
          {cutAtLimit && <p className="recap-picker-limit">12 scenes · Remove a scene before adding photos.</p>}
          <div className="recap-pick-grid">
            {available.map((item) => (
              <button
                type="button"
                key={item.id}
                className={selectedIds.has(item.id) ? "selected" : ""}
                disabled={busy || (cutAtLimit && !selectedIds.has(item.id))}
                aria-label={`${selectedIds.has(item.id) ? "Remove" : "Include"} ${item.fileName}`}
                aria-pressed={selectedIds.has(item.id)}
                onClick={() =>
                  onPhotos(
                    selectedIds.has(item.id)
                      ? scene.photos
                          .filter((photo) => photo.id !== item.id)
                          .map((photo) => photo.id)
                      : [...scene.photos.map((photo) => photo.id), item.id],
                  )
                }
              >
                <img
                  src={`/api/media/${encodeURIComponent(item.id)}?variant=thumb`}
                  alt=""
                  loading="lazy"
                />
                {selectedIds.has(item.id) && (
                  <span>
                    <Check size={16} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      {theatre && (
        <div
          ref={theatreRef}
          className="recap-theatre"
          role="dialog"
          aria-modal="true"
          aria-label="Recap preview"
        >
          {story(true)}
        </div>
      )}
    </section>
  );
}
