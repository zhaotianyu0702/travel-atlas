'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Trash2 } from 'lucide-react';
import DeleteTripDialog from '@/components/DeleteTripDialog';
import type { AiJob, HighlightJob, Photo, Recap, Trip, Workspace } from '@/lib/types';
import { photoCaptureDate } from '@/lib/photo-time';
import { failedLocationPhotoIds, loadAiJob, pollAiJob } from '@/lib/ai-job-poll';
import { importPhotos, type ImportProgress } from '@/lib/browser-import';
import { hasLocation, tripHighlights, tripMarkersFor } from '@/lib/trip-presentation';
import { exportRecap } from '@/lib/browser-export';
import { rememberMusicChoice } from '@/lib/recap-music-preference';
import { buildRecapScene } from '@/lib/recap-story';
import { cutPhotoIds, editRecapCut, type RecapCut } from '@/lib/recap-cut';
import RecapStudio from '@/components/RecapStudio';
import './recap-albums.css';
import PhotoLightbox from '@/components/PhotoLightbox';
import PhotoLibrary from '@/components/PhotoLibrary';
import { useAtlasPlaces } from '@/components/AtlasMapDetails';
import { useVisitedCountryCount } from '@/lib/visited-country';
const AtlasMap = dynamic(() => import('@/components/AtlasMap'), { ssr: false });
type View = 'atlas' | 'trips' | 'recaps';
type Theme = 'mixed' | 'data' | 'story';
type LocationJob = { id: string; tripId: string; photoId: string; status: 'running' | 'queued' | 'succeeded' | 'failed'; candidate: null | { placeName: string; country: string; latitude: number | null; longitude: number | null; confidence: 'medium' | 'high'; precision: string; reason: string; supportingPhotoIds: string[]; evidence: 'visual' | 'time-series' }; reviewed?: 'saved' | 'dismissed'; durationMs: number | null };
const emptyTrip = { title: '', notes: '', startDate: '', endDate: '' };
const dateValue = (s: string | null) => s?.slice(0, 10) || '';
const prettyDate = (s: string | null) => s ? new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unknown';
const image = (p: Photo) => `/api/media/${p.id}?variant=thumb`;
async function request(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status})`);
  return data;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default function Home() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<View>('atlas');
  const [overviewVersion, setOverviewVersion] = useState(0);
  const [mapTripContext,setMapTripContext]=useState(false); const [atlasYear,setAtlasYear]=useState(''); const [showRoute,setShowRoute]=useState(true);
  const [trackPhotoId,setTrackPhotoId]=useState('');
  const timelineScrollIntent = useRef(false);
  const timelinePanel = useRef<HTMLElement>(null);
  const [timelineReveal,setTimelineReveal]=useState<{photoId:string}|null>(null);
  useLayoutEffect(()=>{
    const panel=timelinePanel.current;
    if (!timelineReveal || !panel) return;
    const entry=panel.querySelector<HTMLElement>(`[data-timeline-photo="${CSS.escape(timelineReveal.photoId)}"]`);
    if (!entry) return;
    // A scroll initiated by a pin should keep that photo selected until the user scrolls again.
    timelineScrollIntent.current=false;
    const offset=entry.getBoundingClientRect().top-panel.getBoundingClientRect().top;
    const inset=Math.min(96,panel.clientHeight*.2);
    panel.scrollTo({
      top:panel.scrollTop+offset-inset,
      behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',
    });
  },[timelineReveal]);
  const [focusPhotoId,setFocusPhotoId]=useState(''); const [focusPhotoVersion,setFocusPhotoVersion]=useState(0);
  const [lightPhoto,setLightPhoto]=useState<Photo|null>(null); const [lightList,setLightList]=useState<Photo[]>([]); const [trash,setTrash]=useState<Photo[]>([]); const [groupIds,setGroupIds]=useState<string[]|null>(null);
  const [organizing,setOrganizing]=useState(false);
  const [showAllTripPhotos,setShowAllTripPhotos]=useState(false);
  const [importProgress,setImportProgress]=useState<ImportProgress|null>(null);
  const [highlightJobs,setHighlightJobs]=useState<HighlightJob[]>([]);
  const [highlightErrors,setHighlightErrors]=useState<Record<string,boolean>>({});
  const routePolls=useRef<Record<string,()=>void>>({});
  const routePollVersions=useRef<Record<string,number>>({});
  const routePollMounted=useRef(true);
  useEffect(()=>{routePollMounted.current=true;return ()=>{routePollMounted.current=false;Object.values(routePolls.current).forEach(cancel=>cancel());};},[]);
  const [locationStartErrors,setLocationStartErrors]=useState<Record<string,string[]>>({});
  const [refreshingHighlights,setRefreshingHighlights]=useState(false);
  const [focusVersion, setFocusVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [tripForm, setTripForm] = useState(emptyTrip);
  const [newTripFiles, setNewTripFiles] = useState<File[]>([]);
  const [createdTripId, setCreatedTripId] = useState('');
  const creationIdRef = useRef('');
  const [newTripErrors, setNewTripErrors] = useState<string[]>([]);
  const [editingTrip, setEditingTrip] = useState<string | null>(null);
  const [deletingTrip, setDeletingTrip] = useState<Trip | null>(null);
  const [activeTrip, setActiveTrip] = useState<string>('');
  const [editingPhoto, setEditingPhoto] = useState<Photo | null>(null);
  const [reviewingCandidate, setReviewingCandidate] = useState<'place' | 'time' | null>(null);
  const [candidateApproved, setCandidateApproved] = useState(false);
  const [timeRange, setTimeRange] = useState('');
  const [photoDateChanged, setPhotoDateChanged] = useState(false);
  const [showTripForm, setShowTripForm] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const [job, setJob] = useState<AiJob | null>(null);
  const [locationJobs,setLocationJobs]=useState<LocationJob[]>([]);
  const [locationBusy,setLocationBusy]=useState(false);
  const [locationEdit,setLocationEdit]=useState<LocationJob|null>(null);
  const [locationPatch,setLocationPatch]=useState({placeName:'',country:'',latitude:null as number|null,longitude:null as number|null});
  const refreshLocations = useCallback(async () => { const result = await request('/api/ai/locations'); setLocationJobs(result.jobs); }, []);
  useEffect(() => { void refreshLocations().catch(()=>{}); const focus=()=>{void refreshLocations().catch(()=>{});}; window.addEventListener('focus',focus); window.addEventListener('online',focus); return ()=>{window.removeEventListener('focus',focus);window.removeEventListener('online',focus);}; }, [refreshLocations]);
  const locationsRunning = locationJobs.some(j=>j.status==='running'||j.status==='queued');
  useEffect(() => { if (!locationsRunning) return; const timer=window.setInterval(()=>{void refreshLocations().catch(()=>{});},3000); return ()=>window.clearInterval(timer); }, [locationsRunning,refreshLocations]);
  const [confirmAnalysis, setConfirmAnalysis] = useState<(() => void) | null>(null);
  const [recapTitle, setRecapTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [highlights, setHighlights] = useState('');
  const [tripFilter, setTripFilter] = useState(''); const [loadedTripIds,setLoadedTripIds]=useState<string[]>([]);
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [place, setPlace] = useState('');
  const [theme, setTheme] = useState<Theme>('mixed');
  const [selected, setSelected] = useState<string[]>([]);
  const previousRecapId = useRef('');
  const [autoStartRecap, setAutoStartRecap] = useState(false);
  const [recapId, setRecapId] = useState('');
  const [recapAlbum, setRecapAlbum] = useState<string | null>(null);
  const [recapCut, setRecapCut] = useState<RecapCut | null>(null);
  const [recapExportProgress, setRecapExportProgress] = useState<number | null>(null);
  const reload = useCallback(async () => { const data = await request('/api/workspace'); setWorkspace(data); return data as Workspace; }, []);
  useEffect(() => { reload().catch(e => setError(e.message)); }, [reload]);
  const jobId=job?.id, jobStatus=job?.status;
  useEffect(() => {
    if (!jobId || !jobStatus || !['queued', 'running'].includes(jobStatus)) return;
    return pollAiJob<AiJob>({load:()=>loadAiJob(jobId), onUpdate:j=>{setNotice(n=>n==='Connection interrupted. Checking again in the background.'?'':n); setJob(j); if(j.status==='failed') setError(j.error || 'Suggestions could not be generated.'); if(j.status==='succeeded') {setNotice('Suggestions are ready to review.'); void reload().catch(()=>{});}}, onWaiting:()=>setNotice('Connection interrupted. Checking again in the background.'), onError:message=>setError(message)});
  }, [jobId, jobStatus, reload]);
  const act = async (fn: () => Promise<void>) => { setError(''); setNotice(''); setBusy(true); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); } finally { setBusy(false); } };
  const refreshHighlights=useCallback(async ()=>{
    const data:{jobs:HighlightJob[]}=await request('/api/ai/highlights');
    return data.jobs;
  },[]);
  const hasRunningHighlights=highlightJobs.some(j=>j.status==='running');
  useEffect(()=>{
    let alive=true, checking=false;
    const refresh=async ()=>{
      if(checking||!alive)return;
      checking=true;
      try {
        const jobs=await refreshHighlights();if(!alive)return;
        setHighlightJobs(jobs);
        if(hasRunningHighlights&&!jobs.some(j=>j.status==='running'))await reload();
      } catch {/* Retry on the next background tick or network recovery. */}
      finally {checking=false;}
    };
    void refresh();
    const id=hasRunningHighlights ? window.setInterval(refresh,3000) : undefined;
    window.addEventListener('online',refresh);window.addEventListener('focus',refresh);
    return ()=>{alive=false;window.clearInterval(id);window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh);};
  },[refreshHighlights,hasRunningHighlights,reload]);
  const photos = workspace?.photos || []; const trips = workspace?.trips || [];
  const tripPhotos = useMemo(()=>photos.filter(p => p.tripId === activeTrip),[photos,activeTrip]);
  const atlasPhotos = useMemo(()=>atlasYear ? photos.filter(p=>photoCaptureDate(p).startsWith(atlasYear)) : photos,[photos,atlasYear]);
  const years = Array.from(new Set(photos.map(p=>photoCaptureDate(p).slice(0,4)).filter(Boolean))).sort().reverse();
  const coverFor = (t:Trip) => photos.find(p=>p.id===t.coverPhotoId) || photos.find(p=>p.tripId===t.id&&p.favorite) || photos.find(p=>p.tripId===t.id);
  const countries = useVisitedCountryCount(photos);
  const unresolved = photos.filter(p => !p.confirmed || p.latitude === null || p.longitude === null).length;
  const currentTrip = trips.find(t => t.id === activeTrip);
  const visibleTripPhotos=useMemo(()=>currentTrip&&!showAllTripPhotos&&!groupIds?tripHighlights(currentTrip,tripPhotos):tripPhotos,[currentTrip,groupIds,showAllTripPhotos,tripPhotos]);
  const timelinePhotos=useMemo(()=>[...(groupIds?visibleTripPhotos.filter(p=>groupIds.includes(p.id)):visibleTripPhotos)].sort((a,b)=>timelineTime(a).localeCompare(timelineTime(b))||a.id.localeCompare(b.id)),[groupIds,visibleTripPhotos]);
  const recapTimeline = useMemo(() => {
    const byId = new Map(photos.map(photo => [photo.id, photo]));
    return selected.map(id => byId.get(id)).filter((photo): photo is Photo => !!photo);
  }, [photos, selected]);
  const mapRecap=view==='recaps'&&recapAlbum!==null&&recapTimeline.length>0;
  const atlasPlaces=useAtlasPlaces(view==='recaps'?recapTimeline:timelinePhotos);
  const mapTripPhotos=useMemo(()=>{
    const selectedPhoto = focusPhotoId && tripPhotos.find(photo=>photo.id===focusPhotoId && hasLocation(photo));
    if (selectedPhoto && !timelinePhotos.some(photo=>photo.id===selectedPhoto.id)) return [...timelinePhotos,selectedPhoto].sort((a,b)=>timelineTime(a).localeCompare(timelineTime(b))||a.id.localeCompare(b.id));
    return timelinePhotos;
  },[focusPhotoId,timelinePhotos,tripPhotos]);
  const markers=useMemo(()=>tripMarkersFor(trips,atlasPhotos),[trips,atlasPhotos]);
  const currentHighlights=highlightJobs.find(j=>j.tripId===activeTrip);
  const mapHasTrip=!!activeTrip&&(view==='trips'||view==='atlas'&&mapTripContext);
  const estimatedRoutes=useMemo(()=>{
    const routeTripIds=new Set(mapRecap ? recapTimeline.map(p=>p.tripId) : mapHasTrip ? [activeTrip] : []);
    return trips.filter(t=>routeTripIds.has(t.id)).map(t=>t.estimatedRoute).filter((route):route is NonNullable<typeof route>=>!!route);
  },[activeTrip,mapHasTrip,mapRecap,recapTimeline,trips]);
  const currentTimeline=mapRecap ? recapTimeline : timelinePhotos;
  const activeTimelinePhotoId=currentTimeline.some(p=>p.id===trackPhotoId) ? trackPhotoId : currentTimeline[0]?.id||'';
  const focusTimelinePhoto = (photo: Photo) => {
    setTrackPhotoId(photo.id);
    setFocusPhotoId(photo.id);
    setFocusPhotoVersion(v=>v+1);
  };
  const trackTimelineScroll = (panel: HTMLElement) => {
    if (!timelineScrollIntent.current) return;
    const cards=panel.querySelectorAll<HTMLElement>('[data-timeline-photo]');
    if (!cards.length) return;
    const target=panel.getBoundingClientRect().top+panel.clientHeight*.35;
    let first=panel.scrollHeight-panel.clientHeight-panel.scrollTop<24 ? cards.length-1 : 0, last=cards.length-1;
    while (first<last) {
      const mid=Math.ceil((first+last)/2);
      if (cards[mid].getBoundingClientRect().top<=target) first=mid;
      else last=mid-1;
    }
    setTrackPhotoId(cards[first].dataset.timelinePhoto || '');
  };
  const toAtlas=()=>{setTrackPhotoId('');timelineScrollIntent.current=false;setView('atlas');setOrganizing(false);setMapTripContext(false);setActiveTrip('');setFocusPhotoId('');setOverviewVersion(v=>v+1);};
  const pickHighlights=(tripId:string)=>{setRefreshingHighlights(true);setHighlightErrors(previous=>({...previous,[tripId]:false}));void request('/api/ai/highlights',json('POST',{tripId})).then((result:{job:HighlightJob})=>{
    setHighlightJobs(previous=>[...previous.filter(j=>j.tripId!==result.job.tripId),result.job]);
    if(result.job.status==='succeeded')void reload().catch(()=>{});
  }).catch(()=>setHighlightErrors(previous=>({...previous,[tripId]:true}))).finally(()=>setRefreshingHighlights(false));};
  const importIntoTrip = async (files: File[], tripId: string) => {
    const knownSourceHashes = new Set(photos.filter(photo => photo.tripId === tripId).map(photo => photo.sha256));
    const uncertain = new Set<string>();
    let lastUpdate = -Infinity;
    const result = await importPhotos(files, tripId, { knownSourceHashes, onUncertainWrite: hash => uncertain.add(hash), onProgress: progress => {
      const now = performance.now();
      if (now - lastUpdate >= 150 || progress.completed === progress.total) {
        lastUpdate = now;
        setImportProgress(progress);
      }
    } });
    const fresh = await reload();
    const accepted = new Map(result.imported.map(photo => [photo.id, photo]));
    // A response can disappear after the server has saved the batch.
    for (const photo of fresh.photos) {
      if (photo.tripId === tripId && uncertain.has(photo.sha256) && !knownSourceHashes.has(photo.sha256)) accepted.set(photo.id, photo);
    }
    return { ...result, available: [...accepted.values()] };
  };
  const updateAfterImport=(tripId:string, imported:Photo[], checkExisting=false)=>{
    if(!imported.length&&!checkExisting)return;
    pickHighlights(tripId);
    const withoutGps=imported.filter(p=>!hasLocation(p)).slice(0,6).map(p=>p.id);
    if(withoutGps.length)void startLocations(tripId,withoutGps);
    const routeUrl=`/api/trips/${encodeURIComponent(tripId)}/route`;
    routePolls.current[tripId]?.();
    const version=(routePollVersions.current[tripId] || 0)+1;routePollVersions.current[tripId]=version;
    void request(routeUrl,json('POST',{consent:true})).then(()=>{
      if(!routePollMounted.current || routePollVersions.current[tripId]!==version)return;
      const started=Date.now();
      routePolls.current[tripId]=pollAiJob<{status:string}>({
        load:()=>Date.now()-started>=45000 ? Promise.resolve({status:'failed'}) : request(routeUrl),
        onUpdate:value=>{if(value.status==='done')void reload().catch(()=>{});},
        onWaiting:()=>{},onError:()=>{},
      });
    }).catch(()=>{});
  };
  const photoById = new Map(photos.map(p => [p.id, p]));
  const editingPhotoJob = editingPhoto && job?.tripId === editingPhoto.tripId &&
    job.targetPhotoIds?.includes(editingPhoto.id) ? job : null;
  const editingDateSuggestion = !editingPhoto?.capturedAt && editingPhotoJob?.status === 'succeeded'
    ? editingPhotoJob.result?.timeCandidates?.find(candidate => candidate.photoId === editingPhoto?.id && (candidate.dateFrom || candidate.dateTo))
    : undefined;
  const saveTrip = (e: React.FormEvent) => { e.preventDefault();
    const started = performance.now();
    if (!editingTrip && !newTripFiles.length) { setNewTripErrors(['Choose at least one photo to create your trip.']); return; }
    void act(async () => {
      if (editingTrip) {
        await request(`/api/trips/${editingTrip}`, json('PATCH', tripForm));
        await reload(); setActiveTrip(editingTrip); setEditingTrip(null); setShowTripForm(false); setNotice('Trip saved.'); return;
      }
      let tripId = createdTripId;
      if (!tripId) {
        if (!creationIdRef.current) creationIdRef.current = crypto.randomUUID();
        const result = await request('/api/trips', json('POST', {...tripForm, creationId:creationIdRef.current}));
        tripId = result.id;
        if (!tripId) throw new Error('Trip was created, but its ID was not returned. Refresh to find it before retrying.');
        setCreatedTripId(tripId); setActiveTrip(tripId);
      }
      try {
        const result = await importIntoTrip(newTripFiles, tripId);
        updateAfterImport(tripId,result.available,!!createdTripId&&result.duplicates>0);
        if (result.errors.length) {
          setNewTripErrors(result.errors.map(x=>`${x.fileName}: ${x.error}`));
          setNotice(`${result.imported.length} photos imported · ${importSeconds(started)}. Retry the selection to finish; existing photos will be skipped.`);
          return;
        }
        setNewTripFiles([]); setNewTripErrors([]); setCreatedTripId(''); creationIdRef.current=''; setTripForm(emptyTrip); setShowTripForm(false);
        setFocusVersion(v=>v+1); setNotice(`${result.imported.length} photos imported${result.duplicates ? ` · ${result.duplicates} already in your trip` : ''} · ${importSeconds(started)}.`);
      } finally { setImportProgress(null); }
    });
  };
  const savePhoto = (e: React.FormEvent) => { e.preventDefault(); if (!editingPhoto) return; if (reviewingCandidate && !candidateApproved) { setError('Please review the suggestion before saving.'); return; } if (reviewingCandidate === 'time' && (!photoDateChanged || !editingPhoto.capturedAt)) { setError('Choose a date before saving.'); return; } act(async () => { await request(`/api/photos/${editingPhoto.id}`, json('PATCH', { ...(photoDateChanged ? { capturedAt: editingPhoto.capturedAt || null } : {}), placeName: editingPhoto.placeName, country: editingPhoto.country, latitude: editingPhoto.latitude, longitude: editingPhoto.longitude, notes: editingPhoto.notes, confirmed: reviewingCandidate === 'place' ? true : editingPhoto.confirmed })); setEditingPhoto(null); await reload(); setNotice('Photo details saved.'); }); };
  const startLocations = async (tripId: string, targetPhotoIds?: string[]) => { setLocationBusy(true); setLocationStartErrors(previous=>({...previous,[tripId]:[]})); try { const result: {jobs:LocationJob[]} = await request('/api/ai/locations',json('POST',{tripId,...(targetPhotoIds ? {targetPhotoIds:targetPhotoIds.slice(0,6)} : {})})); setLocationJobs(previous=>[...previous.filter(j=>!result.jobs.some(next=>next.id===j.id)),...result.jobs]); void refreshLocations().catch(()=>{}); } catch { setLocationStartErrors(previous=>({...previous,[tripId]:targetPhotoIds || []})); } finally { setLocationBusy(false); } };
  const reviewLocation = async (jobId:string, action:'save'|'dismiss', patch?:typeof locationPatch) => { setLocationBusy(true); setError(''); try { await request('/api/ai/locations/review',json('POST',{jobId,action,...(patch ? {patch} : {})})); setLocationEdit(null); await Promise.all([refreshLocations(),reload()]); } catch(e) { setError(e instanceof Error ? e.message : 'Could not review location.'); } finally { setLocationBusy(false); } };
  const startAI = (tripId: string, targetPhotoId: string) => setConfirmAnalysis(() => () => {
    void act(async () => {
      const result = await request('/api/ai/jobs', json('POST', { tripId, targetPhotoIds:[targetPhotoId] }));
      setJob(result);
      setNotice(result.status === 'succeeded' ? 'Suggestions are ready to review.' : 'Preparing suggestions. You can keep working while this runs.');
    });
  });
  const loadRecap = (id: string) => { setAutoStartRecap(false); setTrackPhotoId(''); setFocusPhotoId(''); timelineScrollIntent.current=false; const r = workspace?.recaps.find(x => x.id === id); if (!r) return;  setRecapId(r.id); setRecapCut(r.cut ?? null); setRecapTitle(r.title); setSummary(r.summary); setHighlights(r.highlights.join('\n')); setTripFilter(r.tripIds.length === 1 ? r.tripIds[0] : [...new Set(photos.filter(photo=>r.photoIds.includes(photo.id)).map(photo=>photo.tripId))].length===1 ? photos.find(photo=>r.photoIds.includes(photo.id))!.tripId : ''); setLoadedTripIds(r.tripIds.length > 1 ? r.tripIds : []); setFrom(r.startDate || ''); setTo(r.endDate || ''); setPlace(r.place); setTheme(r.theme); setSelected(r.photoIds); };
  const persistRecap = async () => {
    if (!recapTitle.trim()) throw new Error('Give your recap a title.');
    if (!recapTimeline.length) throw new Error('Choose at least one photo.');
    const tripIds = [...new Set(recapTimeline.map(photo => photo.tripId))];
    const saved: Recap = await request(recapId ? `/api/recaps/${recapId}` : '/api/recaps', json(recapId ? 'PATCH' : 'POST', {
      title: recapTitle.trim(), summary, highlights: highlights.split('\n').map(value => value.trim()).filter(Boolean),
      photoIds: recapTimeline.map(photo => photo.id), tripIds, startDate: null, endDate: null, place: '', theme,
      cut: editRecapCut(recapCut, recapTimeline.map(photo => photo.id)),
    }));
    setRecapId(saved.id);
    setRecapAlbum(recapAlbumFor(saved));
    setTripFilter(saved.tripIds.length === 1 ? saved.tripIds[0] : '');
    await reload();
    return saved.id;
  };
  const downloadRecap = (format: 'html' | 'png' | 'mp4', musicId?: string, manualMusicId?: string | null) => {
    void act(async () => {
      setRecapExportProgress(0);
      try {
        const id = await persistRecap();
        if (format === 'html') {
          const response = await fetch(`/api/export/${encodeURIComponent(id)}?format=html`);
          if (!response.ok) {
            const result = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(result.error || 'Could not export this recap.');
          }
          const url = URL.createObjectURL(await response.blob());
          const link = document.createElement('a');
          link.href = url;
          const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/i)?.[1];
          link.download = filename || 'Travel recap.html';
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 60000);
        } else await exportRecap(id, format, setRecapExportProgress, musicId);
        if (format === 'mp4') rememberMusicChoice(id, manualMusicId ?? null);
        setNotice('Recap exported.');
      } finally { setRecapExportProgress(null); }
    });
  };
  const chooseRecapTrip = (id: string) => {
    const trip = trips.find(item => item.id === id);
    setRecapId(''); setRecapCut(null); setTripFilter(id); setLoadedTripIds([]);
    setFrom(''); setTo(''); setPlace(''); setSummary(''); setHighlights(''); setTheme('mixed');
    timelineScrollIntent.current = false;
    setRecapTitle(trip?.title || '');
    setSelected([]);
    setFocusPhotoId(''); setTrackPhotoId(''); setFocusVersion(value => value + 1);
  };
  // Keep cross-trip and orphaned legacy recaps visible in their own albums.
  const recapAlbumFor = (recap: Recap) => {
    const ids = new Set([...recap.tripIds, ...photos.filter(photo => recap.photoIds.includes(photo.id)).map(photo => photo.tripId)].filter(Boolean));
    if (ids.size > 1) return '__across__';
    const id = [...ids][0];
    return id && trips.some(trip => trip.id === id) ? id : '__other__';
  };
  const albumRecaps = (workspace?.recaps || []).filter(recap => recapAlbumFor(recap) === recapAlbum)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const recapIndex = albumRecaps.findIndex(recap => recap.id === recapId);
  const openRecapAlbum = (id: string) => {
    setRecapAlbum(id); setView('recaps'); setMapTripContext(false);
    const first = (workspace?.recaps || []).filter(recap => recapAlbumFor(recap) === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
    if (first) loadRecap(first.id); else { previousRecapId.current = ''; chooseRecapTrip(id.startsWith('__') ? '' : id); setAutoStartRecap(!id.startsWith('__') && photos.some(photo => photo.tripId === id)); }
  };
  const showRecapAlbums = () => {
    setAutoStartRecap(false); setRecapAlbum(null); setSelected([]); setRecapId(''); setTrackPhotoId(''); setFocusPhotoId('');
    timelineScrollIntent.current = false; setOverviewVersion(v => v + 1);
  };
  const albumName = recapAlbum === '__across__' ? 'Across trips' : recapAlbum === '__other__' ? 'Other recaps' : trips.find(trip => trip.id === recapAlbum)?.title || 'Recaps';
  const recapDraft: Recap = {
    id: recapId, accountId: workspace?.account.id || '', title: recapTitle, summary,
    highlights: highlights.split('\n').filter(Boolean), photoIds: recapTimeline.map(photo => photo.id),
    tripIds: [...new Set(recapTimeline.map(photo => photo.tripId))], startDate: null, endDate: null,
    place: '', theme, cut: recapCut, createdAt: '', updatedAt: '',
  };
  const recapScene = buildRecapScene(recapDraft, photos, 'draft');


  const openTrip = (t: Trip) => { setTrackPhotoId(''); timelineScrollIntent.current=false; setPanelExpanded(false); setOrganizing(false); setActiveTrip(t.id); setGroupIds(null); setShowAllTripPhotos(false); setFocusPhotoId(''); setFocusVersion(v=>v+1); setJob(workspace ? [...workspace.jobs].reverse().find(j => j.tripId === t.id) || null : null); setShowTripForm(false); setView('trips'); };
  const deleteTrip = (trip: Trip) => void act(async () => {
    await request(`/api/trips/${encodeURIComponent(trip.id)}`, { method: 'DELETE' });
    routePollVersions.current[trip.id] = (routePollVersions.current[trip.id] || 0) + 1;
    routePolls.current[trip.id]?.();
    delete routePolls.current[trip.id];
    setDeletingTrip(null); setActiveTrip(''); setEditingTrip(null); setShowTripForm(false);
    setOrganizing(false); setMapTripContext(false); setJob(null); setGroupIds(null);
    setFocusPhotoId(''); setTrackPhotoId(''); timelineScrollIntent.current = false;
    setTrash(items => items.filter(photo => photo.tripId !== trip.id));
    setLocationJobs(items => items.filter(item => item.tripId !== trip.id));
    setOverviewVersion(value => value + 1);
    await reload();
    setNotice('Trip deleted.');
  });
  const openPhoto = (p: Photo, candidate: 'place' | 'time' | null = null, proposedDate?: string, range = '') => { if(!candidate){setLightList(photos.filter(x=>x.tripId===p.tripId));setLightPhoto(p);return;} setReviewingCandidate(candidate); setCandidateApproved(false); setTimeRange(range); setPhotoDateChanged(!!proposedDate); setEditingPhoto({...p, ...(proposedDate ? {capturedAt: proposedDate, timeSource: 'user' as const} : {})}); };
  const selectMapPhoto = (photo: Photo) => {
    if (!timelinePanel.current?.querySelector('[data-timeline-photo]')) {
      openPhoto(photo);
      return;
    }
    if (view==='trips' && !timelinePhotos.some(item=>item.id===photo.id)) {
      setGroupIds(null);
      setShowAllTripPhotos(true);
    }
    setTrackPhotoId(photo.id);
    setTimelineReveal({photoId:photo.id});
  };
  return <div className="shell">
    <aside className="rail"><div className="logo" title="Travel Atlas">✳</div><nav aria-label="Main navigation">{([['atlas','◎','Atlas'],['trips','▣','Trips'],['recaps','▤','Recaps']] as const).map(([key,icon,label]) => <button key={key} className={view === key ? 'rail-item active' : 'rail-item'} onClick={() => { if(key==='atlas'){toAtlas();return;} setOrganizing(false);setView(key);if(key==='recaps'){setMapTripContext(false);showRecapAlbums();} }}><span>{icon}</span>{label}</button>)}</nav><button className="rail-item profile-toggle" onClick={() => setShowProfiles(!showProfiles)}><span>◉</span>Profile</button></aside>
    <main className="map-stage"><AtlasMap photos={mapRecap ? recapTimeline : mapHasTrip ? mapTripPhotos : []} tripMarkers={mapHasTrip || mapRecap ? undefined : markers} panelOpen={view!=='atlas'} showRoute={(mapHasTrip||mapRecap)&&showRoute} focusTripId={mapRecap?(recapId||'recap-draft'):mapHasTrip?activeTrip:''} focusVersion={focusVersion} overviewVersion={overviewVersion} focusPhotoId={mapHasTrip||mapRecap?focusPhotoId:''} focusPhotoVersion={focusPhotoVersion} trackPhotoId={mapHasTrip||mapRecap?activeTimelinePhotoId:''} estimatedRoutes={estimatedRoutes} onClearTrack={()=>{setTrackPhotoId('');timelineScrollIntent.current=false;}} onSelectTrip={id=>{const t=trips.find(v=>v.id===id);if(t)openTrip(t);}} onSelectPhoto={selectMapPhoto}/><div className="map-top"><div className="atlas-heading"><div className="map-title"><strong>My Atlas</strong>{view==='atlas' && <><div className="atlas-summary" aria-label="All-time travel summary"><div><b>{workspace ? countries : '–'}</b><span>Countries recorded</span></div><div><b>{workspace ? trips.length : '–'}</b><span>Trips</span></div></div><p className="atlas-guidance">{workspace && !trips.length ? 'Add a trip to start your atlas.' : markers.length ? 'Drag to explore · Select a marker to open a trip' : 'Drag to explore your atlas'}</p></>}</div>{view==='atlas' && (mapTripContext || years.length>1) && <div className="atlas-tools">{mapTripContext && currentTrip && <button className="secondary map-trip-back" onClick={()=>{setMapTripContext(false);openTrip(currentTrip);}}>← {currentTrip.title}</button>}{years.length>1&&<select aria-label="Filter atlas year" value={atlasYear} onChange={e=>{setMapTripContext(false);setActiveTrip('');setFocusPhotoId('');setAtlasYear(e.target.value);setOverviewVersion(v=>v+1);}}><option value="">All years</option>{years.map(y=><option key={y}>{y}</option>)}</select>}{mapTripContext&&<button className={showRoute?"atlas-route active":"atlas-route"} aria-pressed={showRoute} onClick={()=>setShowRoute(!showRoute)}>Visit order</button>}</div>}</div><div className="top-actions"><button className="primary" onClick={() => {setView('trips'); setActiveTrip(''); setEditingTrip(null); setTripForm(emptyTrip); setCreatedTripId(''); creationIdRef.current=''; setNewTripFiles([]); setNewTripErrors([]); setShowTripForm(true);}}>＋ Add trip</button></div></div>
    {showProfiles && <div className="profile-pop"><strong>Profile</strong><span>{workspace?.account.name || 'Private workspace'}</span><a href="/signout-with-chatgpt?return_to=/" target="_top">Sign out</a></div>}
    {(error || notice) && <div className={error?'toast error':'toast'} role={error?'alert':'status'}>{error || notice}<button onClick={()=>{setError('');setNotice('');}} aria-label="Dismiss">×</button></div>}
    {view === 'trips' && <aside ref={timelinePanel} className={`drawer ${panelExpanded ? 'panel-expanded' : ''}`} aria-label="Trips" onPointerDown={e=>{if(e.target===e.currentTarget)timelineScrollIntent.current=true;}} onWheel={()=>{timelineScrollIntent.current=true;}} onTouchMove={()=>{timelineScrollIntent.current=true;}} onKeyDown={e=>{if(['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(e.key))timelineScrollIntent.current=true;}} onScroll={e=>trackTimelineScroll(e.currentTarget)}><button type="button" className="panel-size-toggle" aria-label={panelExpanded ? 'Collapse trips panel' : 'Expand trips panel'} aria-expanded={panelExpanded} onClick={()=>setPanelExpanded(v=>!v)}>{panelExpanded ? '⌄' : '⌃'}</button><div className="drawer-head"><div className="trip-title"><h1>{currentTrip?.title || 'Trips'}</h1>{currentTrip && !showTripForm && <button className="icon-action rename-trip" aria-label="Edit trip" title="Edit trip" onClick={()=>{setEditingTrip(currentTrip.id);setTripForm({title:currentTrip.title,notes:currentTrip.notes,startDate:dateValue(currentTrip.startDate),endDate:dateValue(currentTrip.endDate)});setShowTripForm(true);}}>✎</button>}{currentTrip && !showTripForm && <button type="button" className="icon-action trip-delete-trigger" disabled={busy} aria-label="Delete trip" title="Delete trip" onClick={() => { setError(''); setDeletingTrip(currentTrip); }}><Trash2 size={18}/></button>}</div><button className="icon-button" aria-label="Close trips" onClick={toAtlas}>×</button></div>
      {currentTrip && !showTripForm ? <><div className="row-heading"><strong>{showAllTripPhotos||groupIds?'Photos':'Highlights'}</strong><button className="text-button" onClick={()=>{setShowAllTripPhotos(groupIds?false:!showAllTripPhotos);setGroupIds(null);setFocusPhotoId('');setTrackPhotoId('');timelineScrollIntent.current=false;setFocusVersion(v=>v+1);}}>{showAllTripPhotos||groupIds?'Show highlights':'All photos'}</button></div><div className="trip-actions-bar"><label className="icon-action add-photos" aria-label="Add photos" title="Add photos">Add photos<input type="file" aria-label="Add photos" accept="image/*,.heic,.heif" multiple disabled={busy} onChange={e=>{const files=e.target.files;if(!files?.length)return;const selectedFiles=Array.from(files);const started=performance.now();e.target.value='';act(async()=>{try{const result=await importIntoTrip(selectedFiles,activeTrip);updateAfterImport(activeTrip,result.available);const imported=`${result.imported.length} photos imported${result.duplicates ? ` · ${result.duplicates} duplicates skipped` : ''} · ${importSeconds(started)}.`;if(result.errors.length)setError(`${imported} ${result.errors.map(x=>`${x.fileName}: ${x.error}`).join(' · ')}`);else setNotice(imported);}finally{setImportProgress(null);}});}}/></label><button className="icon-action" aria-label="Organize photos" title="Organize photos" onClick={()=>setOrganizing(true)}>Organize</button><button className="secondary trip-recap" disabled={!tripPhotos.length} onClick={()=>openRecapAlbum(currentTrip.id)}>Recaps</button></div>{importProgress && <PhotoImportStatus progress={importProgress}/>}<p className="import-disclosure">OpenAI checks previews. OSRM uses GPS points to estimate driving routes.</p>{(highlightErrors[activeTrip] || currentHighlights?.status==='failed' || currentHighlights?.status==='succeeded'&&currentHighlights.failedBatches>0) && <p className="muted" role="status">Highlights incomplete. <button className="text-button" disabled={refreshingHighlights||hasRunningHighlights} onClick={()=>pickHighlights(activeTrip)}>Retry</button></p>}<TripTimeline photos={timelinePhotos} places={atlasPlaces} activeId={activeTimelinePhotoId} onOpen={(p,list)=>{setLightList(list);setLightPhoto(p);}} onFocus={focusTimelinePhoto}/><LocationReview tripId={activeTrip} photos={tripPhotos} jobs={locationJobs} busy={locationBusy} startFailed={locationStartErrors[activeTrip] || []} onRetry={ids=>void startLocations(activeTrip,ids)} onEdit={j=>{if(!j.candidate)return;setLocationPatch({placeName:j.candidate.placeName,country:j.candidate.country,latitude:j.candidate.latitude,longitude:j.candidate.longitude});setLocationEdit(j);}} onDismiss={j=>void reviewLocation(j.id,'dismiss')}/>{groupIds && <button className="text-button" onClick={()=>{setShowAllTripPhotos(true);setGroupIds(null);setTrackPhotoId('');timelineScrollIntent.current=false;}}>Show all photos</button>}
      <button className="back-button" onClick={()=>{setActiveTrip('');setJob(null);setFocusPhotoId('');setOverviewVersion(v=>v+1);}}>← All trips</button></> : <>{showTripForm ? <form onSubmit={saveTrip} className="form-stack trip-form"><label>Trip title<input required disabled={busy || !!createdTripId} value={tripForm.title} onChange={e=>setTripForm({...tripForm,title:e.target.value})} placeholder="Name your trip"/></label>{editingTrip ? <div className="form-grid"><label>Start date<input type="date" value={tripForm.startDate} onChange={e=>setTripForm({...tripForm,startDate:e.target.value})}/></label><label>End date<input type="date" value={tripForm.endDate} onChange={e=>setTripForm({...tripForm,endDate:e.target.value})}/></label></div> : <><p className="import-disclosure">OpenAI checks previews. OSRM uses GPS points to estimate driving routes.</p><PhotoPicker files={newTripFiles} disabled={busy} onChange={files=>{setNewTripFiles(files);setNewTripErrors([]);}}/>{newTripErrors.length>0 && <div className="import-errors" role="alert"><strong>Some photos need attention</strong>{newTripErrors.map((message,i)=><p key={i}>{message}</p>)}</div>}{importProgress && <PhotoImportStatus progress={importProgress}/>}{createdTripId && !busy && <p className="muted">Your trip is saved. Retry these photos or open the trip to add them later.</p>}</>}<div className="drawer-actions"><button className="primary" disabled={busy || (!editingTrip && !newTripFiles.length)}>{editingTrip ? 'Save changes' : busy ? (createdTripId ? 'Importing photos…' : 'Creating trip…') : createdTripId ? 'Retry photos' : 'Create trip'}</button><button type="button" className="secondary" disabled={busy} onClick={()=>{setShowTripForm(false);setCreatedTripId('');creationIdRef.current='';setNewTripFiles([]);setNewTripErrors([]);}}> {createdTripId ? 'Open trip' : 'Cancel'}</button></div></form> : <><p className="trip-step">Add a trip → upload photos → explore</p><button className="primary full" onClick={()=>{setEditingTrip(null);setTripForm(emptyTrip);setCreatedTripId('');creationIdRef.current='';setNewTripFiles([]);setNewTripErrors([]);setShowTripForm(true);}}>＋ Add a trip</button><div className="drawer-trip-list">{trips.map(t=><button key={t.id} className="drawer-trip" onClick={()=>openTrip(t)}>{coverFor(t) ? <img src={image(coverFor(t)!)} alt=""/> : <span className="blank-cover">✳</span>}<span><strong>{t.title}</strong><small>{t.startDate ? `${prettyDate(t.startDate)} · ` : ''}{photos.filter(p=>p.tripId===t.id).length} photos</small></span><b>›</b></button>)}</div></>}</>}</aside>}
    {view === 'trips' && currentTrip && organizing && <div className="collection-panel"><button className="icon-button collection-close" aria-label="Close photo organizer" onClick={()=>setOrganizing(false)}>×</button><PhotoLibrary key={activeTrip} photos={tripPhotos} trips={trips} tripId={activeTrip} onOpen={(p,list)=>{setLightList(list);setLightPhoto(p);}} busy={busy} trash={trash} loadTrash={()=>act(async()=>setTrash(await request('/api/photos/trash')))} onRestore={p=>act(async()=>{await request(`/api/photos/${p.id}/restore`,{method:'POST'});setTrash(await request('/api/photos/trash'));await reload();})} onBatch={async(ids,patch)=>{try{await request('/api/photos/batch',json('POST',{photoIds:ids,patch}));await reload();}catch(e){setError(e instanceof Error?e.message:'Batch update failed.');throw e;}}}/></div>}
    {view === 'recaps' && <aside ref={timelinePanel} className={`drawer recap-drawer ${panelExpanded ? 'panel-expanded' : ''}`} aria-label="Recaps">
      <div className="drawer-head"><h1>Recaps</h1><button type="button" className="icon-button" aria-label="Close recaps" onClick={toAtlas}>×</button></div>
      {recapAlbum === null ? <div className="recap-albums">

        {trips.map(trip => {
          const count = (workspace?.recaps || []).filter(recap => recapAlbumFor(recap) === trip.id).length;
          const cover = coverFor(trip);
          return <button type="button" className="recap-album-card" key={trip.id} onClick={() => openRecapAlbum(trip.id)}>
            {cover && <img src={image(cover)} alt="" loading="lazy"/>}<span className="recap-album-shade"/>
            <span className="recap-album-copy"><strong>{trip.title}</strong><small>{count} {count === 1 ? 'recap' : 'recaps'}</small></span><span className="recap-album-arrow" aria-hidden="true">›</span>
          </button>;
        })}
        {(['__across__', '__other__'] as const).map(id => {
          const recaps = (workspace?.recaps || []).filter(recap => recapAlbumFor(recap) === id);
          if (!recaps.length) return null;
          const cover = photos.find(photo => recaps.some(recap => recap.photoIds.includes(photo.id)));
          return <button type="button" className="recap-album-card" key={id} onClick={() => openRecapAlbum(id)}>
            {cover && <img src={image(cover)} alt="" loading="lazy"/>}<span className="recap-album-shade"/>
            <span className="recap-album-copy"><strong>{id === '__across__' ? 'Across trips' : 'Other recaps'}</strong><small>{recaps.length} {recaps.length === 1 ? 'recap' : 'recaps'}</small></span><span className="recap-album-arrow" aria-hidden="true">›</span>
          </button>;
        })}
        {!trips.length && !workspace?.recaps.length && <p className="muted">Add a trip to start your first recap.</p>}
      </div> : <>
        <div className="recap-album-heading"><button type="button" className="text-button" disabled={busy} onClick={showRecapAlbums}>← All recaps</button><h2>{albumName}</h2></div>
        <div className="recap-album-navigation" aria-label="Recap navigation">
          <button type="button" aria-label="Previous recap" disabled={busy || !albumRecaps.length || recapIndex === 0} onClick={() => loadRecap(albumRecaps[recapIndex < 0 ? albumRecaps.length - 1 : recapIndex - 1].id)}>←</button>
          <span aria-live="polite">{recapIndex < 0 ? 'New recap' : `${recapIndex + 1} / ${albumRecaps.length}`}</span>
          <button type="button" aria-label="Next recap" disabled={busy || recapIndex < 0 || recapIndex >= albumRecaps.length - 1} onClick={() => loadRecap(albumRecaps[recapIndex + 1].id)}>→</button>
          {recapIndex >= 0 && !recapAlbum.startsWith('__') && <button type="button" className="recap-new" disabled={busy} onClick={() => { previousRecapId.current = recapId; chooseRecapTrip(recapAlbum); setAutoStartRecap(true); }}>＋ New recap</button>}
          {recapIndex < 0 && <button type="button" className="recap-new" disabled={busy} onClick={() => { const previous = albumRecaps.find(recap => recap.id === previousRecapId.current) || albumRecaps[0]; if (previous) loadRecap(previous.id); else showRecapAlbums(); }}>Cancel</button>}
        </div>
      <RecapStudio key={recapId || `draft:${recapAlbum}`} scene={recapScene} available={tripFilter ? photos.filter(photo => photo.tripId === tripFilter) : photos}
        autoStart={autoStartRecap} onCancelNew={() => { if (!autoStartRecap) return; const previous = albumRecaps.find(recap => recap.id === previousRecapId.current) || albumRecaps[0]; if (previous) loadRecap(previous.id); else showRecapAlbums(); }}
        trips={trips} tripId={tripFilter} busy={busy} progress={recapExportProgress} focusedPhotoId={trackPhotoId}
        onTitle={setRecapTitle} onTrip={chooseRecapTrip}
        onPhotos={ids => { setRecapCut(cut => editRecapCut(cut, ids)); setSelected(ids); }}
        onCut={cut => {
          // A just-composed cut can have newer visual observations than the open workspace.
          void reload().catch(() => {});
          setAutoStartRecap(false); setRecapId(''); setRecapCut(cut); setSelected(cutPhotoIds(cut)); setRecapTitle(cut.title);
          setSummary(''); setHighlights(''); setTrackPhotoId(''); setFocusPhotoId('');
        }}
        onActive={id => { const photo = photos.find(item => item.id === id); if (photo) focusTimelinePhoto(photo); }}
        onSave={() => { void act(async () => { await persistRecap(); setNotice('Recap saved.'); }); }}
        onExport={downloadRecap} />
      </>}
    </aside>}
    </main>{deletingTrip && <DeleteTripDialog trip={deletingTrip} busy={busy} error={error}
      onClose={() => { setDeletingTrip(null); setError(''); }} onDelete={() => deleteTrip(deletingTrip)} />}{lightPhoto && <PhotoLightbox paused={!!editingPhoto} photo={photos.find(p=>p.id===lightPhoto.id)||lightPhoto} photos={lightList.map(p=>photos.find(x=>x.id===p.id)).filter((p):p is Photo=>!!p)} trips={trips} onClose={()=>setLightPhoto(null)} onShow={p=>setLightPhoto(p)} onEdit={p=>{setReviewingCandidate(null);setCandidateApproved(false);setPhotoDateChanged(false);setTimeRange('');setEditingPhoto({...p});}} onFavorite={p=>act(async()=>{await request(`/api/photos/${p.id}`,json('PATCH',{favorite:!p.favorite}));await reload();})} onDelete={p=>act(async()=>{await request(`/api/photos/${p.id}`,{method:'DELETE'});setLightPhoto(null);await reload();setNotice('Photo moved to trash.');})} onCover={p=>act(async()=>{await request(`/api/trips/${p.tripId}`,json('PATCH',{coverPhotoId:p.id}));await reload();setNotice('Trip cover updated.');})}/>}{editingPhoto && <div className="modal-backdrop" onClick={()=>setEditingPhoto(null)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="photo-title" onClick={e=>e.stopPropagation()}><button className="icon-button close" aria-label="Close" onClick={()=>setEditingPhoto(null)}>×</button><div className="modal-image"><img src={image(editingPhoto)} alt={editingPhoto.fileName}/></div><form className="form-stack modal-form" onSubmit={savePhoto}><h2 id="photo-title">Photo details</h2><p className="muted">{editingPhoto.fileName}</p>{!editingPhoto.capturedAt && <div className="photo-ai"><button type="button" className="secondary" disabled={busy || editingPhotoJob?.status==='queued' || editingPhotoJob?.status==='running'} onClick={()=>startAI(editingPhoto.tripId,editingPhoto.id)}>✳ Suggest date</button>{(editingPhotoJob?.status==='queued' || editingPhotoJob?.status==='running') && <small>Checking date…</small>}{editingDateSuggestion && <button type="button" className="text-button" onClick={()=>{
        const {dateFrom,dateTo}=editingDateSuggestion;
        const single=!!dateFrom&&dateFrom===dateTo;
        const range=single?'':[dateFrom&&prettyDate(dateFrom),dateTo&&prettyDate(dateTo)].filter(Boolean).join(' – ');
        openPhoto(editingPhoto,'time',single ? dateFrom : undefined,range);
      }}>Review date</button>}{editingPhotoJob?.status==='succeeded' && !editingDateSuggestion && <small>No reliable date found.</small>}{editingPhotoJob?.status==='failed' && <small role="alert">{editingPhotoJob.error || 'Could not check the date.'}</small>}</div>}{reviewingCandidate==='place' && <p className="review-note">Any suggested coordinates are approximate.</p>}{timeRange && <p className="review-note">Suggested range: {timeRange}. Choose a date to save.</p>}<label>Date<input type="date" required={reviewingCandidate==='time'} value={photoCaptureDate(editingPhoto) || ''} onChange={e=>{setPhotoDateChanged(true);setEditingPhoto({...editingPhoto,capturedAt:e.target.value || null,timeSource:'user'});}}/></label><div className="form-grid"><label>Place<input value={editingPhoto.placeName} onChange={e=>setEditingPhoto({...editingPhoto,placeName:e.target.value})} placeholder="Unknown"/></label><label>Country<input value={editingPhoto.country} onChange={e=>setEditingPhoto({...editingPhoto,country:e.target.value})} placeholder="Unknown"/></label><label>Latitude<input type="number" step="any" min="-90" max="90" value={editingPhoto.latitude ?? ''} onChange={e=>setEditingPhoto({...editingPhoto,latitude:e.target.value===''?null:Number(e.target.value)})}/></label><label>Longitude<input type="number" step="any" min="-180" max="180" value={editingPhoto.longitude ?? ''} onChange={e=>setEditingPhoto({...editingPhoto,longitude:e.target.value===''?null:Number(e.target.value)})}/></label></div>{reviewingCandidate && <><label className="check"><input type="checkbox" required checked={candidateApproved} onChange={e=>setCandidateApproved(e.target.checked)}/> {reviewingCandidate === 'place' ? 'I confirm this location' : 'I have reviewed this date'}</label><button type="button" className="text-button keep-unknown" onClick={()=>setEditingPhoto(null)}>Keep current details</button></>}<button className="primary" disabled={busy}>Save details</button></form></section></div>}
    {locationEdit && <div className="modal-backdrop" onClick={()=>setLocationEdit(null)}><section className="modal privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="location-review-title" onClick={e=>e.stopPropagation()}><form className="form-stack" onSubmit={e=>{e.preventDefault();void reviewLocation(locationEdit.id,'save',locationPatch);}}><h2 id="location-review-title">Review location</h2><p className="muted">{photos.find(p=>p.id===locationEdit.photoId)?.fileName}</p><div className="location-compare" aria-label="Target and supporting photos">{[locationEdit.photoId,...(locationEdit.candidate?.supportingPhotoIds ?? [])].map((id,i)=>{const p=photoById.get(id);return p?<figure key={id}><img src={image(p)} alt={i ? `Supporting photo ${i}` : 'Photo to locate'}/><figcaption>{['Target','Earlier','Later'][i] ?? 'Context'}</figcaption></figure>:null;})}</div><p className="review-note">{locationEdit.candidate?.reason}</p><div className="form-grid"><label>Place<input value={locationPatch.placeName} onChange={e=>setLocationPatch({...locationPatch,placeName:e.target.value})}/></label><label>Country<input value={locationPatch.country} onChange={e=>setLocationPatch({...locationPatch,country:e.target.value})}/></label><label>Latitude<input type="number" step="any" min="-90" max="90" value={locationPatch.latitude ?? ''} onChange={e=>setLocationPatch({...locationPatch,latitude:e.target.value===''?null:Number(e.target.value)})}/></label><label>Longitude<input type="number" step="any" min="-180" max="180" value={locationPatch.longitude ?? ''} onChange={e=>setLocationPatch({...locationPatch,longitude:e.target.value===''?null:Number(e.target.value)})}/></label></div><div className="drawer-actions"><button type="button" className="secondary" onClick={()=>setLocationEdit(null)}>Cancel</button><button className="primary" disabled={locationBusy}>Save location</button></div></form></section></div>}
    {confirmAnalysis && <div className="modal-backdrop" onClick={()=>setConfirmAnalysis(null)}><section className="modal privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="analysis-title" onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape')setConfirmAnalysis(null);}}><div className="form-stack">
      <h2 id="analysis-title">Analyze photos with OpenAI?</h2>
      <p>OpenAI receives up to 8 photo previews and their known dates, locations and notes, plus the current trip or recap context. Originals stay in your private atlas.</p>
      <div className="drawer-actions"><button type="button" className="secondary" autoFocus onClick={()=>setConfirmAnalysis(null)}>Cancel</button><button type="button" className="primary" onClick={()=>{const run=confirmAnalysis;setConfirmAnalysis(null);run();}}>Analyze</button></div>
    </div></section></div>}</div>;
}

function timelineTime(p:Photo) {
  if (!photoCaptureDate(p)) return '9999';
  return p.timeSource === 'user' ? p.capturedAt! : p.timeMetadata?.localDateTime || p.capturedAt!;
}
function timelineDate(p:Photo) {
  const date=photoCaptureDate(p); if(!date)return '';
  const value=timelineTime(p), time=/T(\d{2}):(\d{2})/.exec(value);
  const timeLabel=time ? new Date(2000,0,1,Number(time[1]),Number(time[2])).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : '';
  return `${prettyDate(date)}${timeLabel ? ` · ${timeLabel}${!p.timeMetadata?.localDateTime && value.endsWith('Z') ? ' UTC' : ''}` : ''}`;
}
function TripTimeline({photos,places,activeId,onOpen,onFocus}:{photos:Photo[];places:Record<string,{name:string;nearby:boolean}>;activeId:string;onOpen:(p:Photo,list:Photo[])=>void;onFocus:(p:Photo)=>void}) {
  let previousPlace='', undated=false;
  return <div className="trip-timeline">{photos.map(p=>{
    const unknownDate=!photoCaptureDate(p), showUndated=unknownDate&&!undated;undated=unknownDate;
    const explicit=p.placeName.trim();const derived=places[p.id];
    const place=explicit&&explicit.toLocaleLowerCase()!==p.country.trim().toLocaleLowerCase()?explicit:derived?.name??'';
    const heading=place&&place!==previousPlace?place:'';previousPlace=place;
    return <div className={`timeline-entry ${activeId===p.id?'active':''}`} data-timeline-photo={p.id} aria-current={activeId===p.id||undefined} key={p.id}>
      {showUndated && <h2 className="timeline-place">Date unknown</h2>}{heading && <h2 className="timeline-place">{heading}</h2>}
      <div className="timeline-date">{timelineDate(p)}</div><div className="timeline-image"><button className="timeline-photo" onClick={()=>onOpen(p,photos)} aria-label={`Open ${p.fileName}`}><img src={image(p)} alt="" width={p.width||undefined} height={p.height||undefined} loading="lazy"/>{p.favorite&&<span className="trip-heart">♥</span>}</button>{hasLocation(p) && <button className="focus-photo" onClick={()=>onFocus(p)} aria-label={`Show ${p.fileName} on map`}>◎</button>}</div>
    </div>;
  })}{!photos.length && <p className="muted">No photos yet.</p>}</div>;
}

const importSeconds = (started: number) => ((performance.now() - started) / 1000).toFixed(1) + ' s';
function PhotoImportStatus({progress}: {progress: ImportProgress}) {
  const { completed, prepared, total } = progress;
  return <div className="photo-import-status">
    <progress aria-label="Photos processed" value={completed} max={total} />
    <span>{completed ? `${completed} / ${total} processed` : `Preparing · ${prepared} / ${total}`}</span>
  </div>;
}

function PhotoPicker({files,disabled,onChange}:{files:File[];disabled:boolean;onChange:(files:File[])=>void}) {
  const [previews,setPreviews]=useState<string[]>([]);
  const [dragging,setDragging]=useState(false);
  useEffect(()=>{const urls=files.slice(0,6).map(file=>URL.createObjectURL(file));setPreviews(urls);return ()=>urls.forEach(url=>URL.revokeObjectURL(url));},[files]);
  const choose=(list:FileList | null)=>{
    if (!list?.length) return;
    const sameFile=(file:File)=>JSON.stringify([file.name,file.size,file.lastModified]);
    onChange([...new Map([...files,...list].map(file=>[sameFile(file),file])).values()]);
  };
  return <div className="photo-picker" data-dragging={dragging||undefined} onDragOver={e=>{e.preventDefault();if(!disabled)setDragging(true);}}
    onDragLeave={e=>{if(!(e.relatedTarget instanceof Node)||!e.currentTarget.contains(e.relatedTarget))setDragging(false);}}
    onDrop={e=>{e.preventDefault();setDragging(false);if(!disabled)choose(e.dataTransfer.files);}}>
    <label className="photo-picker-label"><span aria-hidden="true">＋</span><strong>Drop photos here</strong><small>or choose photos</small><input type="file" accept="image/*,.heic,.heif" multiple disabled={disabled} onChange={e=>{choose(e.target.files);e.target.value='';}}/></label>
    {files.length>0 && <><div className="picker-previews">{previews.map((src,i)=><img key={src} src={src} alt={files[i]?.name || 'Selected photo'}/>)}</div><div className="picker-selection"><span>{files.length} {files.length===1?'photo':'photos'} selected</span><button className="text-button" type="button" disabled={disabled} onClick={()=>onChange([])}>Clear</button></div></>}
  </div>;
}

function Evidence({ids,photos}:{ids:string[];photos:Photo[]}) { const evidence=ids.map(id=>photos.find(p=>p.id===id)).filter((p):p is Photo=>!!p); return evidence.length ? <details className="evidence"><summary>Context photos · {evidence.length}</summary><div>{evidence.map(p=><img key={p.id} src={image(p)} alt={p.fileName} title={p.fileName}/>)}</div></details> : null; }

function LocationReview({tripId,photos,jobs,busy,startFailed,onRetry,onEdit,onDismiss}:{tripId:string;photos:Photo[];jobs:LocationJob[];busy:boolean;startFailed:string[];onRetry:(ids:string[])=>void;onEdit:(job:LocationJob)=>void;onDismiss:(job:LocationJob)=>void}) {
  const current=jobs.filter(j=>j.tripId===tripId);
  const running=current.some(j=>j.status==='queued'||j.status==='running');
  const candidates=current.filter(j=>{const p=photos.find(p=>p.id===j.photoId);const c=j.candidate;return j.status==='succeeded'&&!j.reviewed&&!!p&&!p.confirmed&&(p.latitude===null||p.longitude===null)&&!!c&&c.precision!=='unknown'&&(c.confidence==='medium'||c.confidence==='high')&&!!(c.placeName||c.country||(c.latitude!==null&&c.longitude!==null));});
  const failed=failedLocationPhotoIds(current,photos);
  if (!running && !failed.length && !candidates.length && !startFailed.length) return null;
  return <section className="location-review">{running && <p className="muted" role="status">Finding locations…</p>}{(failed.length>0 || startFailed.length>0) && <p className="muted" role="status">Some locations could not be checked. <button className="text-button" disabled={busy||running} onClick={()=>onRetry(Array.from(new Set([...failed,...startFailed])))}>Retry</button></p>}{candidates.length>0 && <details className="location-candidates"><summary>Review locations · {candidates.length}</summary>{candidates.map(j=>{const p=photos.find(p=>p.id===j.photoId)!;const c=j.candidate!;return <div className="candidate" key={j.id}><div className="candidate-main"><img src={image(p)} alt=""/><p><strong>{p.fileName}</strong><br/>{[c.placeName,c.country].filter(Boolean).join(', ')||'Estimated coordinates'} · {c.precision} · {c.confidence} confidence<br/><small>{c.reason}</small></p></div><Evidence ids={c.supportingPhotoIds} photos={photos}/><div className="drawer-actions"><button className="secondary" disabled={busy} onClick={()=>onEdit(j)}>Review and save</button><button className="text-button" disabled={busy} onClick={()=>onDismiss(j)}>Dismiss</button></div></div>;})}</details>}</section>;
}
