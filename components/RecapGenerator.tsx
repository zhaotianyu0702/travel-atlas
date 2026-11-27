"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Clock, MapPin, LoaderCircle, Play, Sparkles, Users, X } from "lucide-react";
import { AiPollError, pollAiJob } from "@/lib/ai-job-poll";
import { cutPhotoIds, type RecapCut, type RecapCutJob, type RecapDirection, type RecapGuidance, type RecapPresentation, type RecapTheme } from "@/lib/recap-cut";
import { photoCaptureDate } from "@/lib/photo-time";
import type { Photo } from "@/lib/types";
import "./recap-wizard.css";

type Props = { tripId: string; photos: Photo[]; disabled: boolean; onPreview: (cut: RecapCut) => void; onApply: (cut: RecapCut) => void; onOpenChange: (open: boolean) => void; autoStart?: boolean; onCancel: () => void };
type Stage = RecapGuidance["stage"];
const endpoint = "/api/ai/recap-cuts";
const thumbnail = (id: string) => `/api/media/${encodeURIComponent(id)}?variant=thumb`;

async function readJob(response: Response): Promise<RecapCutJob> {
  const value = await response.json().catch(() => ({})) as RecapCutJob;
  if (!response.ok) throw new AiPollError(value.error || `Request failed (${response.status}).`, response.status === 429 || response.status >= 500);
  return value;
}

export default function RecapGenerator(props: Props) {
  const contextKey = JSON.stringify([props.tripId, props.photos.filter(photo => photo.tripId === props.tripId).map(photo => photo.id).sort()]);
  return <RecapWizard key={contextKey} {...props} />;
}

function RecapWizard({ tripId, photos, disabled, onPreview, onApply, onOpenChange, autoStart, onCancel }: Props) {
  const available = useMemo(() => photos.filter(photo => photo.tripId === tripId).sort((a, b) =>
    photoCaptureDate(a).localeCompare(photoCaptureDate(b)) || (a.capturedAt ?? "").localeCompare(b.capturedAt ?? "") || a.id.localeCompare(b.id)), [photos, tripId]);
  // Keep the AI candidate pool bounded. Review can include any photo in the trip.
  const pool = useMemo(() => available.length <= 100 ? available : Array.from({ length: 100 }, (_, i) => available[Math.round(i * (available.length - 1) / 99)]), [available]);
  const [open, setOpen] = useState(!!autoStart);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<RecapDirection | null>(null);
  const [themes, setThemes] = useState<RecapTheme[]>([]);
  const [theme, setTheme] = useState("");
  const [count, setCount] = useState(8);
  const [chosen, setChosen] = useState<string[]>([]);
  const [style, setStyle] = useState<RecapPresentation["style"]>("minimal");
  const [text, setText] = useState<RecapPresentation["text"]>("places");
  const [showAllPhotos, setShowAllPhotos] = useState(false);
  const [cut, setCut] = useState<RecapCut | null>(null);
  const [job, setJob] = useState<RecapCutJob | null>(null);
  const [activeStage, setActiveStage] = useState<Stage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const pending = submitting || job?.status === "queued" || job?.status === "running";
  const validIds = new Set(available.map(photo => photo.id));
  const jobId = job?.id;
  const status = job?.status;

  useEffect(() => { onOpenChange(open); }, [open, onOpenChange]);
  useEffect(() => () => { generation.current++; }, []);

  function receive(value: RecapCutJob, stage: Stage) {
    setJob(value);
    if (value.status === "failed") { setError(value.error || "Something went wrong. Try again."); return; }
    if (value.status !== "succeeded") return;
    if (stage === "themes") {
      const found = (value.themes ?? []).filter(item => item.title?.trim() && item.photoIds?.some(id => validIds.has(id)));
      if (!found.length) { setError("Could not find theme suggestions. Try again or choose another direction."); return; }
      setThemes(found);
    } else if (stage === "select") {
      const ids = [...new Set(value.selectedPhotoIds ?? [])].filter(id => validIds.has(id)).slice(0, 12);
      if (!ids.length) { setError("Could not select photos. Try again."); return; }
      setChosen(ids); setShowAllPhotos(false); setStep(3);
    } else {
      const result = value.cuts?.[0];
      if (!result || cutPhotoIds(result).length !== chosen.length || new Set(cutPhotoIds(result)).size !== chosen.length || !cutPhotoIds(result).every(id => chosen.includes(id))) { setError("Could not assemble this recap. Try again."); return; }
      setCut(result); setStep(5);
    }
  }

  useEffect(() => {
    if (!jobId || !activeStage || (status !== "queued" && status !== "running")) return;
    const token = generation.current;
    return pollAiJob({
      load: async () => readJob(await fetch(`${endpoint}/${encodeURIComponent(jobId)}`)),
      onUpdate: value => { if (generation.current === token) { setWaiting(false); receive(value, activeStage); } },
      onWaiting: () => { if (generation.current === token) setWaiting(true); },
      onError: message => { if (generation.current === token) { setJob(null); setError(message); } },
    });
  // The job captures the inputs at submission; changing a step cancels its poll.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, status, activeStage]);

  async function generate(stage: Stage) {
    if (pending || disabled || !pool.length || !direction) return;
    const token = ++generation.current;
    setActiveStage(stage); setSubmitting(true); setJob(null); setError(""); setWaiting(false);
    const ids = stage === "compose" ? chosen : pool.map(photo => photo.id);
    try {
      const value = await readJob(await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripId, stage, direction, photoIds: ids, requiredPhotoIds: stage === "compose" ? ids : [],
          ...(stage !== "themes" ? { theme: theme.trim() } : {}),
          ...(stage === "select" ? { count: Math.min(count, pool.length), anchorIds: themes.find(item => item.title === theme)?.photoIds ?? [] } : {}),
          ...(stage === "compose" ? { presentation: { style, text } } : {}) }) }));
      if (generation.current === token) receive(value, stage);
    } catch (cause) {
      if (generation.current === token) setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    } finally { if (generation.current === token) setSubmitting(false); }
  }

  function goBack() {
    generation.current++; setJob(null); setSubmitting(false); setWaiting(false); setError(""); setCut(null);
    setStep(value => Math.max(0, value - 1));
  }
  function togglePhoto(id: string) {
    setChosen(ids => ids.includes(id) ? ids.filter(item => item !== id) : ids.length < 12 ? [...ids, id] : ids);
  }
  if (!available.length) return null;
  return <section className="recap-wizard" aria-label="Generate a recap">
    <button type="button" className="rw-launch" disabled={disabled} aria-expanded={open} onClick={() => {
      if (open) { generation.current++; setJob(null); setSubmitting(false); setOpen(false); onOpenChange(false); onCancel(); }
      else { setOpen(true); onOpenChange(true); if (step === 1 && direction && !themes.length) void generate("themes"); }
    }}><Sparkles size={19} /> Generate recap</button>
    {open && <div className="rw-panel">
      <div className="rw-top"><span>CREATE A RECAP · {Math.min(step + 1, 6)} / 6</span><button type="button" className="rw-close" aria-label="Close" onClick={() => { generation.current++; setJob(null); setSubmitting(false); setOpen(false); onOpenChange(false); onCancel(); }}><X size={20} /></button></div>
      <div className="rw-progress" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map(i => <span key={i} className={i <= step ? "active" : ""} />)}</div>
      {step === 0 && <><h3>Choose a story direction</h3><div className="rw-directions">{([
        { value: "timeline", title: "Trip flow", detail: "Follow the journey over time", icon: Clock },
        { value: "subject", title: "A subject", detail: "Focus on people, wildlife, or a shared theme", icon: Users },
        { value: "place", title: "One place", detail: "Explore a location in detail", icon: MapPin },
      ] as const).map(item => <button type="button" key={item.value} className={direction === item.value ? "selected" : ""} aria-pressed={direction === item.value} onClick={() => { if (direction !== item.value) { setDirection(item.value); setThemes([]); setTheme(""); setChosen([]); setCut(null); } }}><item.icon size={23} /><span><strong>{item.title}</strong><small>{item.detail}</small></span></button>)}</div></>}
      {step === 1 && <><h3>Choose a theme</h3>
        {!!themes.length && <div className="rw-themes">{themes.map(item => <button type="button" key={item.title} className={theme === item.title ? "selected" : ""} aria-pressed={theme === item.title} disabled={!!pending || disabled} onClick={() => setTheme(item.title)}>
          <img src={thumbnail(item.photoIds.find(id => validIds.has(id))!)} alt="" /><span>{item.title}</span>{theme === item.title && <Check className="rw-theme-check" size={18} />}</button>)}</div>}
      </>}
      {step === 2 && <><h3>How many photos?</h3><div className="rw-amounts">{([4, 8, 12] as const).map((n, i) => <button type="button" key={n} className={count === n ? "selected" : ""} aria-pressed={count === n} onClick={() => setCount(n)}><strong>{["Small", "Medium", "Large"][i]}</strong><span>{Math.min(n, pool.length)} photos</span></button>)}</div></>}
      {step === 3 && <><h3>Review your photos</h3><div className="rw-review-switch"><button type="button" aria-pressed={!showAllPhotos} onClick={() => setShowAllPhotos(false)}>{chosen.length} selected</button><button type="button" aria-pressed={showAllPhotos} onClick={() => setShowAllPhotos(true)}>All photos</button></div>
        <div className="rw-photos">{available.filter(photo => showAllPhotos || chosen.includes(photo.id)).map(photo => {
        const selected = chosen.includes(photo.id);
        return <button type="button" key={photo.id} className={selected ? "selected" : ""} aria-pressed={selected} aria-label={`${selected ? "Remove" : "Add"} ${photo.fileName}`} disabled={!selected && chosen.length >= 12} onClick={() => togglePhoto(photo.id)}><img src={thumbnail(photo.id)} alt="" loading="lazy" /><span>{selected && <Check size={16} />}</span></button>;
      })}</div>{!showAllPhotos && !chosen.length && <p>Open All photos to add a photo.</p>}</>}
      {step === 4 && <><h3>Choose the look</h3><fieldset className="rw-options rw-styles"><legend>Style</legend><div>{(["minimal", "cinematic", "dynamic"] as const).map(value => <button type="button" key={value} className={style === value ? "selected" : ""} aria-pressed={style === value} onClick={() => setStyle(value)}><span className={`rw-style-preview ${value}`}><img src={thumbnail(chosen[0])} alt="" />{value === "dynamic" && <img src={thumbnail(chosen[1] ?? chosen[0])} alt="" />}</span>{value}</button>)}</div></fieldset><fieldset className="rw-options"><legend>On-screen text</legend><div>{(["none", "places", "story"] as const).map(value => <button type="button" key={value} className={text === value ? "selected" : ""} aria-pressed={text === value} onClick={() => setText(value)}>{value === "places" ? "Places only" : value === "story" ? "Story captions" : "None"}</button>)}</div></fieldset></>}
      {step === 5 && cut && <><h3>{cut.title}</h3><div className="rw-preview-strip">{cutPhotoIds(cut).map(id => <img key={id} src={thumbnail(id)} alt="" />)}</div><div className="rw-finish"><button type="button" className="rw-secondary" disabled={disabled} onClick={() => onPreview(cut)}><Play size={17} /> Preview</button><button type="button" className="rw-primary" disabled={disabled} onClick={() => { if (cutPhotoIds(cut).every(id => validIds.has(id))) { onApply(cut); setOpen(false); onOpenChange(false); } else setError("Photos changed. Please create the recap again."); }}><Check size={17} /> Use recap</button></div></>}
      {pending && <div className="rw-status" role="status"><LoaderCircle className="spinning" size={18} /><span>{waiting ? "Reconnecting…" : activeStage === "themes" ? "Finding themes…" : activeStage === "select" ? "Choosing photos…" : "Creating your recap…"}{!waiting && job && job.totalCount > 0 ? ` ${job.analyzedCount}/${job.totalCount}` : ""}</span></div>}
      {error && <div className="rw-error" role="alert">{error} {activeStage && <button type="button" disabled={!!pending || disabled} onClick={() => void generate(activeStage)}>Try again</button>}</div>}
      {step < 5 && <div className="rw-footer">{step > 0 ? <button type="button" className="rw-secondary" disabled={!!pending} onClick={goBack}><ArrowLeft size={17} /> Back</button> : <span />}
        <button type="button" className="rw-primary" disabled={!!pending || disabled || (step === 0 && !direction) || (step === 1 && !theme.trim()) || (step === 3 && !chosen.length)} onClick={() => {
          setError(""); if (step === 0) { setStep(1); if (!themes.length) void generate("themes"); } else if (step === 2) void generate("select"); else if (step === 4) void generate("compose"); else setStep(step + 1);
        }}>{step === 2 ? "Choose photos" : step === 4 ? "Create recap" : "Continue"} <ArrowRight size={17} /></button></div>}
      {step === 5 && <div className="rw-footer"><button type="button" className="rw-secondary" onClick={goBack}><ArrowLeft size={17} /> Back</button></div>}
    </div>}
  </section>;
}
