'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { AiJob, HighlightJob, Photo, Trip, Workspace } from '@/lib/types';
import { photoCaptureDate } from '@/lib/photo-time';
import { failedLocationPhotoIds, loadAiJob, pollAiJob } from '@/lib/ai-job-poll';
import { importPhotos, type ImportProgress } from '@/lib/browser-import';
import { hasLocation, tripHighlights, tripMarkersFor } from '@/lib/trip-presentation';
import { exportRecap } from '@/lib/browser-export';
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
const prettyDate = (s: string | null) => s ? new Date(s.length === 10 ? `${s}T12:00:00` : s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unknown';
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
  const [recapScope,setRecapScope]=useState<'trip'|'year'|'place'|'custom'>('trip'); const [recapJob,setRecapJob]=useState<AiJob|null>(null);
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
  const [showIdeas,setShowIdeas]=useState(false);
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
  const [recapId, setRecapId] = useState(''); const [previewVersion,setPreviewVersion]=useState(0);
  const reload = useCallback(async () => { const data = await request('/api/workspace'); setWorkspace(data); return data as Workspace; }, []);
  useEffect(() => { reload().catch(e => setError(e.message)); }, [reload]);
  const jobId=job?.id, jobStatus=job?.status, recapJobId=recapJob?.id, recapJobStatus=recapJob?.status;
  useEffect(() => {
    if (!jobId || !jobStatus || !['queued', 'running'].includes(jobStatus)) return;
    return pollAiJob<AiJob>({load:()=>loadAiJob(jobId), onUpdate:j=>{setNotice(n=>n==='Connection interrupted. Checking again in the background.'?'':n); setJob(j); if(j.status==='failed') setError(j.error || 'Suggestions could not be generated.'); if(j.status==='succeeded') {setNotice('Suggestions are ready to review.'); void reload().catch(()=>{});}}, onWaiting:()=>setNotice('Connection interrupted. Checking again in the background.'), onError:message=>setError(message)});
  }, [jobId, jobStatus, reload]);
  useEffect(() => {
    if (!recapJobId || !recapJobStatus || !['queued', 'running'].includes(recapJobStatus)) return;
    return pollAiJob<AiJob>({load:()=>loadAiJob(recapJobId), onUpdate:j=>{setNotice(n=>n==='Connection interrupted. Checking again in the background.'?'':n);setRecapJob(j);}, onWaiting:()=>setNotice('Connection interrupted. Checking again in the background.'), onError:message=>setError(message)});
  }, [recapJobId, recapJobStatus]);
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
  const filtered = useMemo(() => photos.filter(p => (!tripFilter || p.tripId === tripFilter) && (!loadedTripIds.length || loadedTripIds.includes(p.tripId)) && (!from || (!!photoCaptureDate(p) && photoCaptureDate(p)! >= from)) && (!to || (!!photoCaptureDate(p) && photoCaptureDate(p)! <= to)) && (!place || `${p.placeName} ${p.country}`.toLowerCase().includes(place.toLowerCase()))).sort((a,b)=>timelineTime(a).localeCompare(timelineTime(b))||a.id.localeCompare(b.id)), [photos, tripFilter, loadedTripIds, from, to, place]);
  const selectedInScope = selected.filter(id => filtered.some(p => p.id === id));
  const recapInputKey = [...(selectedInScope.length ? selectedInScope : filtered.map(p=>p.id))].sort().join('|');
  useEffect(()=>{if(recapJob?.scope && [...recapJob.scope.photoIds].sort().join('|')!==recapInputKey)setRecapJob(null);},[recapInputKey,recapJob]);
  const countries = useVisitedCountryCount(photos);
  const unresolved = photos.filter(p => !p.confirmed || p.latitude === null || p.longitude === null).length;
  const currentTrip = trips.find(t => t.id === activeTrip);
  const visibleTripPhotos=useMemo(()=>currentTrip&&!showAllTripPhotos&&!groupIds?tripHighlights(currentTrip,tripPhotos):tripPhotos,[currentTrip,groupIds,showAllTripPhotos,tripPhotos]);
  const timelinePhotos=useMemo(()=>[...(groupIds?visibleTripPhotos.filter(p=>groupIds.includes(p.id)):visibleTripPhotos)].sort((a,b)=>timelineTime(a).localeCompare(timelineTime(b))||a.id.localeCompare(b.id)),[groupIds,visibleTripPhotos]);
  const recapTimeline=useMemo(()=>[...filtered.filter(photo=>selected.includes(photo.id))].sort((a,b)=>timelineTime(a).localeCompare(timelineTime(b))||a.id.localeCompare(b.id)),[filtered,selected]);
  const mapRecap=view==='recaps'&&recapTimeline.length>0;
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
  const pendingTimes = (job?.result?.timeCandidates || []).filter(c => { const p = photoById.get(c.photoId); return !!p && !p.capturedAt; });
  const pendingIssues = (job?.result?.issues || []).filter(issue => { const p = photoById.get(issue.photoId); if (!p) return false; if (issue.kind === 'missing-time') return !p.capturedAt; if (issue.kind === 'missing-location') return p.latitude === null || p.longitude === null; return true; });
  const saveTrip = (e: React.FormEvent) => { e.preventDefault();
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
        const result = await importPhotos(newTripFiles, tripId, { onProgress:setImportProgress });
        updateAfterImport(tripId,result.imported,!!createdTripId&&result.duplicates>0);
        await reload();
        if (result.errors.length) {
          setNewTripErrors(result.errors.map(x=>`${x.fileName}: ${x.error}`));
          setNotice(`${result.imported.length} photos imported. Retry the selection to finish; existing photos will be skipped.`);
          return;
        }
        setNewTripFiles([]); setNewTripErrors([]); setCreatedTripId(''); creationIdRef.current=''; setTripForm(emptyTrip); setShowTripForm(false);
        setFocusVersion(v=>v+1); setNotice(`${result.imported.length} photos imported${result.duplicates ? ` · ${result.duplicates} already in your trip` : ''}.`);
      } finally { setImportProgress(null); }
    });
  };
  const savePhoto = (e: React.FormEvent) => { e.preventDefault(); if (!editingPhoto) return; if (reviewingCandidate && !candidateApproved) { setError('Please review the suggestion before saving.'); return; } if (reviewingCandidate === 'time' && (!photoDateChanged || !editingPhoto.capturedAt)) { setError('Choose a date before saving.'); return; } act(async () => { await request(`/api/photos/${editingPhoto.id}`, json('PATCH', { ...(photoDateChanged ? { capturedAt: editingPhoto.capturedAt || null } : {}), placeName: editingPhoto.placeName, country: editingPhoto.country, latitude: editingPhoto.latitude, longitude: editingPhoto.longitude, notes: editingPhoto.notes, confirmed: reviewingCandidate === 'place' ? true : editingPhoto.confirmed })); setEditingPhoto(null); await reload(); setNotice('Photo details saved.'); }); };
  const startLocations = async (tripId: string, targetPhotoIds?: string[]) => { setLocationBusy(true); setLocationStartErrors(previous=>({...previous,[tripId]:[]})); try { const result: {jobs:LocationJob[]} = await request('/api/ai/locations',json('POST',{tripId,...(targetPhotoIds ? {targetPhotoIds:targetPhotoIds.slice(0,6)} : {})})); setLocationJobs(previous=>[...previous.filter(j=>!result.jobs.some(next=>next.id===j.id)),...result.jobs]); void refreshLocations().catch(()=>{}); } catch { setLocationStartErrors(previous=>({...previous,[tripId]:targetPhotoIds || []})); } finally { setLocationBusy(false); } };
  const reviewLocation = async (jobId:string, action:'save'|'dismiss', patch?:typeof locationPatch) => { setLocationBusy(true); setError(''); try { await request('/api/ai/locations/review',json('POST',{jobId,action,...(patch ? {patch} : {})})); setLocationEdit(null); await Promise.all([refreshLocations(),reload()]); } catch(e) { setError(e instanceof Error ? e.message : 'Could not review location.'); } finally { setLocationBusy(false); } };
  const startAI = (tripId = activeTrip, targetPhotoId?: string) => setConfirmAnalysis(() => () => {
    setShowIdeas(false);
    void act(async () => {
      const result = await request('/api/ai/jobs', json('POST', { tripId, ...(targetPhotoId ? {targetPhotoIds:[targetPhotoId]} : {}) }));
      setJob(result);
      setNotice(result.status === 'succeeded' ? 'Suggestions are ready to review.' : 'Preparing suggestions. You can keep working while this runs.');
    });
  });
  const loadRecap = (id: string) => { setTrackPhotoId(''); setFocusPhotoId(''); timelineScrollIntent.current=false; const r = workspace?.recaps.find(x => x.id === id); if (!r) return; setRecapJob(null); setRecapId(r.id); setRecapTitle(r.title); setSummary(r.summary); setHighlights(r.highlights.join('\n')); setTripFilter(r.tripIds.length === 1 ? r.tripIds[0] : ''); setLoadedTripIds(r.tripIds.length > 1 ? r.tripIds : []); setFrom(r.startDate || ''); setTo(r.endDate || ''); setPlace(r.place); setTheme(r.theme); setSelected(r.photoIds); };
  const saveRecap = (e: React.FormEvent) => { e.preventDefault(); act(async () => { const r = await request(recapId ? `/api/recaps/${recapId}` : '/api/recaps', json(recapId ? 'PATCH' : 'POST', { title: recapTitle, summary, highlights: highlights.split('\n').map(s => s.trim()).filter(Boolean), photoIds: selectedInScope, tripIds: tripFilter ? [tripFilter] : loadedTripIds, startDate: from || null, endDate: to || null, place, theme })); setRecapId(r.id); setPreviewVersion(v=>v+1); await reload(); setNotice('Recap saved. Your exports are ready.'); }); };

  const openTrip = (t: Trip) => { setTrackPhotoId(''); timelineScrollIntent.current=false; setPanelExpanded(false); setShowIdeas(false); setOrganizing(false); setActiveTrip(t.id); setGroupIds(null); setShowAllTripPhotos(false); setFocusPhotoId(''); setFocusVersion(v=>v+1); setJob(workspace ? [...workspace.jobs].reverse().find(j => j.tripId === t.id) || null : null); setShowTripForm(false); setView('trips'); };
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
    <aside className="rail"><div className="logo" title="Travel Atlas">✳</div><nav aria-label="Main navigation">{([['atlas','◎','Atlas'],['trips','▣','Trips'],['recaps','▤','Recaps']] as const).map(([key,icon,label]) => <button key={key} className={view === key ? 'rail-item active' : 'rail-item'} onClick={() => { if(key==='atlas'){toAtlas();return;} setOrganizing(false);setView(key);if(key==='recaps'){setMapTripContext(false);setFocusPhotoId('');setOverviewVersion(v=>v+1);} }}><span>{icon}</span>{label}</button>)}</nav><button className="rail-item profile-toggle" onClick={() => setShowProfiles(!showProfiles)}><span>◉</span>Profile</button></aside>
    <main className="map-stage"><AtlasMap photos={mapRecap ? recapTimeline : mapHasTrip ? mapTripPhotos : []} tripMarkers={mapHasTrip || mapRecap ? undefined : markers} panelOpen={view!=='atlas'} showRoute={(mapHasTrip||mapRecap)&&showRoute} focusTripId={mapRecap?(recapId||'recap-draft'):mapHasTrip?activeTrip:''} focusVersion={focusVersion} overviewVersion={overviewVersion} focusPhotoId={mapHasTrip||mapRecap?focusPhotoId:''} focusPhotoVersion={focusPhotoVersion} trackPhotoId={mapHasTrip||mapRecap?activeTimelinePhotoId:''} estimatedRoutes={estimatedRoutes} onClearTrack={()=>{setTrackPhotoId('');timelineScrollIntent.current=false;}} onSelectTrip={id=>{const t=trips.find(v=>v.id===id);if(t)openTrip(t);}} onSelectPhoto={selectMapPhoto}/><div className="map-top"><div className="atlas-heading"><div className="map-title"><strong>My Atlas</strong>{view==='atlas' && <><div className="atlas-summary" aria-label="All-time travel summary"><div><b>{workspace ? countries : '–'}</b><span>Countries recorded</span></div><div><b>{workspace ? trips.length : '–'}</b><span>Trips</span></div></div><p className="atlas-guidance">{workspace && !trips.length ? 'Add a trip to start your atlas.' : markers.length ? 'Drag to explore · Select a marker to open a trip' : 'Drag to explore your atlas'}</p></>}</div>{view==='atlas' && (mapTripContext || years.length>1) && <div className="atlas-tools">{mapTripContext && currentTrip && <button className="secondary map-trip-back" onClick={()=>{setMapTripContext(false);openTrip(currentTrip);}}>← {currentTrip.title}</button>}{years.length>1&&<select aria-label="Filter atlas year" value={atlasYear} onChange={e=>{setMapTripContext(false);setActiveTrip('');setFocusPhotoId('');setAtlasYear(e.target.value);setOverviewVersion(v=>v+1);}}><option value="">All years</option>{years.map(y=><option key={y}>{y}</option>)}</select>}{mapTripContext&&<button className={showRoute?"atlas-route active":"atlas-route"} aria-pressed={showRoute} onClick={()=>setShowRoute(!showRoute)}>Visit order</button>}</div>}</div><div className="top-actions"><button className="primary" onClick={() => {setView('trips'); setActiveTrip(''); setEditingTrip(null); setTripForm(emptyTrip); setCreatedTripId(''); creationIdRef.current=''; setNewTripFiles([]); setNewTripErrors([]); setShowTripForm(true);}}>＋ Add trip</button></div></div>
    {showProfiles && <div className="profile-pop"><strong>Profile</strong><span>{workspace?.account.name || 'Private workspace'}</span><a href="/signout-with-chatgpt?return_to=/" target="_top">Sign out</a></div>}
    {(error || notice) && <div className={error?'toast error':'toast'} role={error?'alert':'status'}>{error || notice}<button onClick={()=>{setError('');setNotice('');}} aria-label="Dismiss">×</button></div>}
    {view === 'trips' && <aside ref={timelinePanel} className={`drawer ${panelExpanded ? 'panel-expanded' : ''}`} aria-label="Trips" onPointerDown={e=>{if(e.target===e.currentTarget)timelineScrollIntent.current=true;}} onWheel={()=>{timelineScrollIntent.current=true;}} onTouchMove={()=>{timelineScrollIntent.current=true;}} onKeyDown={e=>{if(['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(e.key))timelineScrollIntent.current=true;}} onScroll={e=>trackTimelineScroll(e.currentTarget)}><button type="button" className="panel-size-toggle" aria-label={panelExpanded ? 'Collapse trips panel' : 'Expand trips panel'} aria-expanded={panelExpanded} onClick={()=>setPanelExpanded(v=>!v)}>{panelExpanded ? '⌄' : '⌃'}</button><div className="drawer-head"><div className="trip-title"><h1>{currentTrip?.title || 'Trips'}</h1>{currentTrip && !showTripForm && <button className="icon-action rename-trip" aria-label="Edit trip" title="Edit trip" onClick={()=>{setEditingTrip(currentTrip.id);setTripForm({title:currentTrip.title,notes:currentTrip.notes,startDate:dateValue(currentTrip.startDate),endDate:dateValue(currentTrip.endDate)});setShowTripForm(true);}}>✎</button>}</div><button className="icon-button" aria-label="Close trips" onClick={toAtlas}>×</button></div>
      {currentTrip && !showTripForm ? <><div className="row-heading"><strong>{showAllTripPhotos||groupIds?'Photos':'Highlights'}</strong><button className="text-button" onClick={()=>{setShowAllTripPhotos(groupIds?false:!showAllTripPhotos);setGroupIds(null);setFocusPhotoId('');setTrackPhotoId('');timelineScrollIntent.current=false;setFocusVersion(v=>v+1);}}>{showAllTripPhotos||groupIds?'Show highlights':'All photos'}</button></div><div className="trip-actions-bar"><label className="icon-action add-photos" aria-label="Add photos" title="Add photos">Add photos<input type="file" aria-label="Add photos" accept="image/*,.heic,.heif" multiple disabled={busy} onChange={e=>{const files=e.target.files;if(!files?.length)return;const selectedFiles=Array.from(files);e.target.value='';act(async()=>{try{const result=await importPhotos(selectedFiles,activeTrip,{onProgress:setImportProgress});updateAfterImport(activeTrip,result.imported);await reload();const imported=`${result.imported.length} photos imported${result.duplicates ? ` · ${result.duplicates} duplicates skipped` : ''}.`;if(result.errors.length)setError(`${imported} ${result.errors.map(x=>`${x.fileName}: ${x.error}`).join(' · ')}`);else setNotice(imported);}finally{setImportProgress(null);}});}}/></label><button className="icon-action" aria-label="Organize photos" title="Organize photos" onClick={()=>setOrganizing(true)}>Organize</button><button className="secondary trip-recap" disabled={!tripPhotos.length} onClick={()=>{setRecapId('');setRecapJob(null);setRecapScope('trip');setRecapTitle(currentTrip.title);setSummary('');setHighlights('');setTripFilter(currentTrip.id);setLoadedTripIds([]);setFrom('');setTo('');setPlace('');setTheme('mixed');setSelected(tripHighlights(currentTrip,tripPhotos).map(p=>p.id));setTrackPhotoId('');setFocusPhotoId('');timelineScrollIntent.current=false;setView('recaps');}}>Make recap</button></div><p className="import-disclosure">OpenAI checks previews. OSRM uses GPS points to estimate driving routes.</p>{(highlightErrors[activeTrip] || currentHighlights?.status==='failed' || currentHighlights?.status==='succeeded'&&currentHighlights.failedBatches>0) && <p className="muted" role="status">Highlights incomplete. <button className="text-button" disabled={refreshingHighlights||hasRunningHighlights} onClick={()=>pickHighlights(activeTrip)}>Retry</button></p>}<TripTimeline photos={timelinePhotos} places={atlasPlaces} activeId={activeTimelinePhotoId} onOpen={(p,list)=>{setLightList(list);setLightPhoto(p);}} onFocus={focusTimelinePhoto}/><LocationReview tripId={activeTrip} photos={tripPhotos} jobs={locationJobs} busy={locationBusy} startFailed={locationStartErrors[activeTrip] || []} onRetry={ids=>void startLocations(activeTrip,ids)} onEdit={j=>{if(!j.candidate)return;setLocationPatch({placeName:j.candidate.placeName,country:j.candidate.country,latitude:j.candidate.latitude,longitude:j.candidate.longitude});setLocationEdit(j);}} onDismiss={j=>void reviewLocation(j.id,'dismiss')}/>{importProgress&&<p className="muted" role="status">{importProgress.phase==='preparing' ? `Preparing ${importProgress.prepared} of ${importProgress.total}` : `Uploading · ${importProgress.completed} of ${importProgress.total} processed`}</p>}{groupIds && <button className="text-button" onClick={()=>{setShowAllTripPhotos(true);setGroupIds(null);setTrackPhotoId('');timelineScrollIntent.current=false;}}>Show all photos</button>}
      {job?.result && job.tripId === activeTrip && <details id="trip-ai-ideas" className="suggestion" open={showIdeas} onToggle={e=>setShowIdeas(e.currentTarget.open)}><summary>AI ideas · {job.status==='succeeded'?'Ready':job.status==='failed'?'Failed':'Preparing'}</summary>{!['queued','running'].includes(job.status) && <button className="text-button" disabled={busy} onClick={()=>startAI()}>Regenerate</button>}{job.analyzedPhotoIds && <small>Reviewed {job.analyzedPhotoIds.length} of {job.totalPhotoCount ?? tripPhotos.length} photos</small>}{['queued','running'].includes(job.status) && <p>Preparing suggestions…</p>}{job.status==='failed' && <p>{job.error || 'Suggestions failed.'}</p>}{job.result && <><h3>{job.result.title}</h3><p>{job.result.summary}</p>{job.result.groups.map((g,i)=><button className="scene-group" key={i} onClick={()=>{setGroupIds(g.photoIds);setTrackPhotoId('');timelineScrollIntent.current=false;}}><strong>{g.name}</strong> · {g.photoIds.length} photos<br/><small>{g.reason}</small></button>)}<button className="secondary" onClick={()=>{setRecapTitle(job.result!.title);setSummary(job.result!.summary);setHighlights(job.result!.highlights.join('\n'));setTripFilter(activeTrip);setLoadedTripIds([]);setFrom('');setTo('');setPlace('');setTheme('mixed');setSelected(job.result!.selectedPhotoIds);setRecapId('');setView('recaps');}}>Use suggested selection ↗</button>{pendingTimes.length>0 && <><h4>Dates to review</h4>{pendingTimes.map((c,i)=>{const p=photos.find(p=>p.id===c.photoId);const unknown=!c.dateFrom&&!c.dateTo;const single=!!c.dateFrom&&c.dateFrom===c.dateTo;const range=unknown?'Date unresolved':single?prettyDate(c.dateFrom):`${c.dateFrom ? prettyDate(c.dateFrom) : 'Unknown start'} – ${c.dateTo ? prettyDate(c.dateTo) : 'Unknown end'}`;return <div className="candidate" key={i}><div className="candidate-main">{p && <img src={image(p)} alt=""/>}<p><strong>{p?.fileName || 'Photo'}</strong><br/>{range}{!unknown && ` · ${c.confidence} confidence`}<br/><small>{c.reason}</small></p></div><Evidence ids={c.supportingPhotoIds || []} photos={photos}/>{!unknown && p && <button className="secondary" onClick={()=>openPhoto(p,'time',single ? c.dateFrom! : undefined,single ? '' : range)}>{single ? 'Review date' : 'Choose date'}</button>}{unknown && <small>Keep current date</small>}</div>;})}</>}{pendingIssues.length>0 && <details className="issue-list"><summary>Photo alerts · {pendingIssues.length}</summary>{pendingIssues.map((issue,i)=>{const p=photos.find(p=>p.id===issue.photoId);const label={'no-subject':'Subject unclear','blurred':'Blurred','missing-location':'Location missing','missing-time':'Date missing','conflicting-context':'Conflicting evidence','insufficient-evidence':'Not enough evidence'}[issue.kind];return <div className="candidate-main" key={i}>{p && <img src={image(p)} alt=""/>}<p><strong>{label}</strong> · {p?.fileName || 'Photo'}<br/><small>{issue.message}</small></p></div>;})}</details>}</>}</details>}<button className="back-button" onClick={()=>{setActiveTrip('');setJob(null);setFocusPhotoId('');setOverviewVersion(v=>v+1);}}>← All trips</button></> : <>{showTripForm ? <form onSubmit={saveTrip} className="form-stack trip-form"><label>Trip title<input required disabled={busy || !!createdTripId} value={tripForm.title} onChange={e=>setTripForm({...tripForm,title:e.target.value})} placeholder="Name your trip"/></label>{editingTrip ? <div className="form-grid"><label>Start date<input type="date" value={tripForm.startDate} onChange={e=>setTripForm({...tripForm,startDate:e.target.value})}/></label><label>End date<input type="date" value={tripForm.endDate} onChange={e=>setTripForm({...tripForm,endDate:e.target.value})}/></label></div> : <><p className="import-disclosure">OpenAI checks previews. OSRM uses GPS points to estimate driving routes.</p><PhotoPicker files={newTripFiles} disabled={busy} onChange={files=>{setNewTripFiles(files);setNewTripErrors([]);}}/>{newTripErrors.length>0 && <div className="import-errors" role="alert"><strong>Some photos need attention</strong>{newTripErrors.map((message,i)=><p key={i}>{message}</p>)}</div>}{importProgress && <p role="status">{importProgress.phase==='preparing' ? `Preparing ${importProgress.prepared} of ${importProgress.total}` : `Uploading · ${importProgress.completed} of ${importProgress.total} processed`}</p>}{createdTripId && !busy && <p className="muted">Your trip is saved. Retry these photos or open the trip to add them later.</p>}</>}<div className="drawer-actions"><button className="primary" disabled={busy || (!editingTrip && !newTripFiles.length)}>{editingTrip ? 'Save changes' : busy ? (createdTripId ? 'Importing photos…' : 'Creating trip…') : createdTripId ? 'Retry photos' : 'Create trip'}</button><button type="button" className="secondary" disabled={busy} onClick={()=>{setShowTripForm(false);setCreatedTripId('');creationIdRef.current='';setNewTripFiles([]);setNewTripErrors([]);}}> {createdTripId ? 'Open trip' : 'Cancel'}</button></div></form> : <><p className="trip-step">Add a trip → upload photos → explore</p><button className="primary full" onClick={()=>{setEditingTrip(null);setTripForm(emptyTrip);setCreatedTripId('');creationIdRef.current='';setNewTripFiles([]);setNewTripErrors([]);setShowTripForm(true);}}>＋ Add a trip</button><div className="drawer-trip-list">{trips.map(t=><button key={t.id} className="drawer-trip" onClick={()=>openTrip(t)}>{coverFor(t) ? <img src={image(coverFor(t)!)} alt=""/> : <span className="blank-cover">✳</span>}<span><strong>{t.title}</strong><small>{t.startDate ? `${prettyDate(t.startDate)} · ` : ''}{photos.filter(p=>p.tripId===t.id).length} photos</small></span><b>›</b></button>)}</div></>}</>}</aside>}
    {view === 'trips' && currentTrip && organizing && <div className="collection-panel"><button className="icon-button collection-close" aria-label="Close photo organizer" onClick={()=>setOrganizing(false)}>×</button><PhotoLibrary key={activeTrip} photos={tripPhotos} trips={trips} tripId={activeTrip} onOpen={(p,list)=>{setLightList(list);setLightPhoto(p);}} busy={busy} trash={trash} loadTrash={()=>act(async()=>setTrash(await request('/api/photos/trash')))} onRestore={p=>act(async()=>{await request(`/api/photos/${p.id}/restore`,{method:'POST'});setTrash(await request('/api/photos/trash'));await reload();})} onBatch={async(ids,patch)=>{try{await request('/api/photos/batch',json('POST',{photoIds:ids,patch}));await reload();}catch(e){setError(e instanceof Error?e.message:'Batch update failed.');throw e;}}}/></div>}
    {view === 'recaps' && <aside ref={timelinePanel} className={`drawer recap-drawer ${panelExpanded ? 'panel-expanded' : ''}`} aria-label="Recaps" onWheel={()=>{timelineScrollIntent.current=true;}} onTouchMove={()=>{timelineScrollIntent.current=true;}} onScroll={e=>trackTimelineScroll(e.currentTarget)}><button type="button" className="panel-size-toggle" aria-label={panelExpanded ? 'Collapse recaps panel' : 'Expand recaps panel'} aria-expanded={panelExpanded} onClick={()=>setPanelExpanded(v=>!v)}>{panelExpanded ? '⌄' : '⌃'}</button><div className="drawer-head"><div><h1>Recaps</h1></div><button className="icon-button" aria-label="Close recaps" onClick={toAtlas}>×</button></div>{workspace?.recaps.length ? <div className="saved-list">{workspace.recaps.map(r=><button key={r.id} className={recapId===r.id?'saved active':'saved'} onClick={()=>loadRecap(r.id)}><strong>{r.title}</strong><small>{r.photoIds.filter(id=>photoById.has(id)).length} photos</small></button>)}<button className="saved new" onClick={()=>{setRecapId('');setRecapJob(null);setRecapTitle('');setSummary('');setHighlights('');setTripFilter('');setLoadedTripIds([]);setFrom('');setTo('');setPlace('');setTheme('mixed');setSelected([]);}}>＋ New</button></div>:null}<form className="form-stack" onSubmit={saveRecap}>
      {recapTimeline.length>0 && <><h2 className="recap-photo-title">{recapTitle||'Photo recap'}</h2>
        {recapTitle.trim() && <button className="primary recap-save" disabled={busy}>{recapId?'Save changes':'Save recap'}</button>}
        <TripTimeline photos={recapTimeline} places={atlasPlaces} activeId={activeTimelinePhotoId}
          onOpen={(p,list)=>{setLightList(list);setLightPhoto(p);}} onFocus={focusTimelinePhoto}/></>}
      <details className="recap-editor" open={!recapTimeline.length || !recapTitle.trim() || undefined}>
        <summary>{recapTimeline.length?'Edit recap':'Choose photos'}</summary>
        <div className="scope-tabs">{(['trip','year','place','custom'] as const).map(x=><button key={x} className={recapScope===x?'active':''} onClick={()=>{setRecapScope(x);setLoadedTripIds([]);if(x==='year'||x==='place'){setTripFilter('');}if(x==='trip'||x==='place'){setFrom('');setTo('');}if(x==='trip'||x==='year'){setPlace('');}}}>{x[0].toUpperCase()+x.slice(1)}</button>)}</div><details className="recap-filters"><summary>Filter photos</summary>{recapScope==='year' && <label>Year<select value={from && from.slice(0,4)===to.slice(0,4)?from.slice(0,4):''} onChange={e=>{setFrom(e.target.value?`${e.target.value}-01-01`:'');setTo(e.target.value?`${e.target.value}-12-31`:'');}}><option value="">Choose year</option>{years.map(y=><option key={y}>{y}</option>)}</select></label>}<div className="form-grid"><label>Trip<select value={tripFilter} onChange={e=>{setTripFilter(e.target.value);setLoadedTripIds([]);}}><option value="">All trips</option>{trips.map(t=><option value={t.id} key={t.id}>{t.title}</option>)}</select></label><label>Place<input value={place} onChange={e=>setPlace(e.target.value)} placeholder="All places"/></label><label>From<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>To<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></div></details><div className="row-heading"><strong>Photos</strong><span>{selectedInScope.length} selected · {filtered.length} shown</span><button type="button" className="text-button" onClick={()=>setSelected(filtered.map(p=>p.id))}>Select all</button></div><div className="select-photos">{[...filtered].sort((a,b)=>timelineTime(a).localeCompare(timelineTime(b))||a.id.localeCompare(b.id)).map(p=><button type="button" aria-label={`Select ${p.fileName}`} aria-pressed={selected.includes(p.id)} key={p.id} className={selected.includes(p.id)?'select-photo selected':'select-photo'} onClick={()=>setSelected(s=>s.includes(p.id)?s.filter(id=>id!==p.id):[...s,p.id])}><img src={image(p)} alt=""/><span>{selected.includes(p.id)?selected.indexOf(p.id)+1:'+'}</span></button>)}</div>{!filtered.length && <p className="muted">No photos in this scope.</p>}{selectedInScope.length>0 && <details className="order-list"><summary>Photo order</summary>{selectedInScope.map((id,i)=><div key={id}><span>{i+1}. {photos.find(p=>p.id===id)?.fileName}</span><button type="button" aria-label="Move photo earlier" disabled={i===0} onClick={()=>setSelected(s=>{const n=[...s],a=n.indexOf(id),b=n.indexOf(selectedInScope[i-1]);[n[a],n[b]]=[n[b],n[a]];return n;})}>↑</button><button type="button" aria-label="Move photo later" disabled={i===selectedInScope.length-1} onClick={()=>setSelected(s=>{const n=[...s],a=n.indexOf(id),b=n.indexOf(selectedInScope[i+1]);[n[a],n[b]]=[n[b],n[a]];return n;})}>↓</button></div>)}</details>}<label>Title<input required value={recapTitle} onChange={e=>setRecapTitle(e.target.value)} placeholder="Recap title"/></label><button type="button" className="secondary" disabled={busy || !filtered.length || !!recapJob && ['queued','running'].includes(recapJob.status)} onClick={()=>{const ids=selectedInScope.length?selectedInScope:filtered.map(p=>p.id);setConfirmAnalysis(()=>()=>{void act(async()=>{setRecapJob(await request('/api/ai/jobs',json('POST',{photoIds:ids,title:recapTitle || 'Travel recap'})));});});}}>{recapJob && ['queued','running'].includes(recapJob.status)?'Preparing…':'✳ Suggest recap'}</button>{recapJob?.status==='failed' && <p className="muted">{recapJob.error || 'Suggestions failed.'}</p>}{recapJob?.result && <div className="recap-suggestion"><strong>{recapJob.result.title}</strong><p>{recapJob.result.summary}</p>{recapJob.result.groups.map((g,i)=><small key={i}>{g.name}: {g.reason}<br/></small>)}<button type="button" className="text-button" onClick={()=>{setRecapTitle(recapJob.result!.title);setSummary(recapJob.result!.summary);setHighlights(recapJob.result!.highlights.join('\n'));setSelected(recapJob.result!.selectedPhotoIds);}}>Use suggestions</button></div>}<div className="row-heading"><strong>Style</strong></div><div className="theme-options">{(['mixed','data','story'] as Theme[]).map(x=><button type="button" key={x} className={theme===x?'theme active':'theme'} onClick={()=>setTheme(x)}><span>{x==='mixed'?'▦':x==='data'?'◉':'▤'}</span><strong>{x[0].toUpperCase()+x.slice(1)}</strong></button>)}</div><label>Story<textarea value={summary} onChange={e=>setSummary(e.target.value)} placeholder="Optional"/></label><label>Highlights<textarea value={highlights} onChange={e=>setHighlights(e.target.value)}/></label>{!recapTitle.trim()&&<button className="primary recap-save" disabled>Save recap</button>}
      </details></form>{recapId && <div className="export-links"><a href={`/api/export/${recapId}?format=html&preview=1`} target="_blank" rel="noreferrer">Preview ↗</a><a href={`/api/export/${recapId}?format=html`}>HTML ↓</a><details className="export-more"><summary>More formats</summary><button type="button" disabled={busy} onClick={()=>act(async()=>{await exportRecap(recapId,'png');})}>Image ↓</button><button type="button" disabled={busy} onClick={()=>act(async()=>{await exportRecap(recapId,'mp4');})}>Video ↓</button></details><small>Downloads include the saved text and visible photos. Anyone you send the file to can open it.</small></div>}{recapId&&<details className="recap-inline-preview"><summary>Saved recap preview</summary><iframe key={`${recapId}-${previewVersion}`} title="Saved recap preview" sandbox="" src={`/api/export/${recapId}?format=html&preview=1`}/></details>}</aside>}
    </main>{lightPhoto && <PhotoLightbox paused={!!editingPhoto} photo={photos.find(p=>p.id===lightPhoto.id)||lightPhoto} photos={lightList.map(p=>photos.find(x=>x.id===p.id)).filter((p):p is Photo=>!!p)} trips={trips} onClose={()=>setLightPhoto(null)} onShow={p=>setLightPhoto(p)} onEdit={p=>{setReviewingCandidate(null);setCandidateApproved(false);setPhotoDateChanged(false);setTimeRange('');setEditingPhoto({...p});}} onFavorite={p=>act(async()=>{await request(`/api/photos/${p.id}`,json('PATCH',{favorite:!p.favorite}));await reload();})} onDelete={p=>act(async()=>{await request(`/api/photos/${p.id}`,{method:'DELETE'});setLightPhoto(null);await reload();setNotice('Photo moved to trash.');})} onCover={p=>act(async()=>{await request(`/api/trips/${p.tripId}`,json('PATCH',{coverPhotoId:p.id}));await reload();setNotice('Trip cover updated.');})}/>}{editingPhoto && <div className="modal-backdrop" onClick={()=>setEditingPhoto(null)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="photo-title" onClick={e=>e.stopPropagation()}><button className="icon-button close" aria-label="Close" onClick={()=>setEditingPhoto(null)}>×</button><div className="modal-image"><img src={image(editingPhoto)} alt={editingPhoto.fileName}/></div><form className="form-stack modal-form" onSubmit={savePhoto}><h2 id="photo-title">Photo details</h2><p className="muted">{editingPhoto.fileName}</p><div className="photo-ai"><button type="button" className="secondary" disabled={busy || !!job && job.tripId===editingPhoto.tripId && ['queued','running'].includes(job.status)} onClick={()=>startAI(editingPhoto.tripId,editingPhoto.id)}>✳ Suggest details</button>{job && job.tripId===editingPhoto.tripId && ['queued','running'].includes(job.status) && <small>Preparing suggestions…</small>}{job && job.tripId===editingPhoto.tripId && job.status==='succeeded' && <button type="button" className="text-button" onClick={()=>{const t=trips.find(x=>x.id===editingPhoto.tripId);setEditingPhoto(null);setLightPhoto(null);if(t){openTrip(t);setShowIdeas(true);}}}>Open suggestions ↗</button>}{job && job.tripId===editingPhoto.tripId && job.status==='failed' && <small role="alert">{job.error || 'Suggestions failed.'}</small>}</div>{reviewingCandidate==='place' && <p className="review-note">Any suggested coordinates are approximate.</p>}{timeRange && <p className="review-note">Suggested range: {timeRange}. Choose a date to save.</p>}<label>Date<input type="date" required={reviewingCandidate==='time'} value={photoCaptureDate(editingPhoto) || ''} onChange={e=>{setPhotoDateChanged(true);setEditingPhoto({...editingPhoto,capturedAt:e.target.value || null,timeSource:'user'});}}/></label><div className="form-grid"><label>Place<input value={editingPhoto.placeName} onChange={e=>setEditingPhoto({...editingPhoto,placeName:e.target.value})} placeholder="Unknown"/></label><label>Country<input value={editingPhoto.country} onChange={e=>setEditingPhoto({...editingPhoto,country:e.target.value})} placeholder="Unknown"/></label><label>Latitude<input type="number" step="any" min="-90" max="90" value={editingPhoto.latitude ?? ''} onChange={e=>setEditingPhoto({...editingPhoto,latitude:e.target.value===''?null:Number(e.target.value)})}/></label><label>Longitude<input type="number" step="any" min="-180" max="180" value={editingPhoto.longitude ?? ''} onChange={e=>setEditingPhoto({...editingPhoto,longitude:e.target.value===''?null:Number(e.target.value)})}/></label></div>{reviewingCandidate && <><label className="check"><input type="checkbox" required checked={candidateApproved} onChange={e=>setCandidateApproved(e.target.checked)}/> {reviewingCandidate === 'place' ? 'I confirm this location' : 'I have reviewed this date'}</label><button type="button" className="text-button keep-unknown" onClick={()=>setEditingPhoto(null)}>Keep current details</button></>}<button className="primary" disabled={busy}>Save details</button></form></section></div>}
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
