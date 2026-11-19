'use client';
import { useRef, useState } from 'react';
import type { LocationSuggestion } from '@/lib/types';

type Target = {id:string;capturedAt:string|null;preview:string};
type Neighbor = Target & {latitude:number;longitude:number};
type Case = {target:Target;neighbors:Neighbor[]};
type Mode = 'context'|'image-only'|'cascade';
type Stage = {model:string;stage:'light'|'strong';seconds:number;inputTokens?:number;outputTokens?:number};
type Outcome = 'skipped'|'accepted'|'different'|'uncertain'|'unavailable';
type Patch = {placeName:string;country:string;latitude:number|null;longitude:number|null};
type Raw = Patch & {confidence:string;precision:string;evidence:string};
type Result = {caseId:string;mode:Mode;candidate:LocationSuggestion|null;raw:Raw|null;providerSeconds:number;model:string;anchorCount:number;roundtripMs:number;stages?:Stage[];outcome?:Outcome;review:null|{action:'saved'|'dismissed';patch:Patch|null;elapsedMs:number}};
const text = (v:unknown, max=300):string => {if(typeof v!=='string'||v.length>max||v.includes('data:image/')) throw new Error('Invalid text field'); return v;};
const coord = (v:unknown, max:number):number|null => {if(v===null)return null;if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>max)throw new Error('Invalid coordinate');return v;};
const stamp = (v:unknown) => v===null ? null : text(v,100);
const preview = (v:unknown) => {if(typeof v!=='string'||v.length>8_000_000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(v))throw new Error('Expected a masked JPEG data URL');return v;};
function manifest(value:unknown):Case[] {
  if(!value||typeof value!=='object'||!Array.isArray((value as {cases?:unknown}).cases))throw new Error('Expected {cases: [...]}');
  const entries=(value as {cases:unknown[]}).cases;if(entries.length>100)throw new Error('At most 100 cases are supported');
  const cases=entries.map((entry):Case=>{const e=entry as {target:Record<string,unknown>;neighbors:Record<string,unknown>[]};if(!e?.target||!Array.isArray(e.neighbors)||e.neighbors.length>8)throw new Error('Invalid case or too many neighbors');const target={id:text(e.target.id,100),capturedAt:stamp(e.target.capturedAt),preview:preview(e.target.preview)};if(!target.id)throw new Error('Case IDs must not be empty');return {target,neighbors:e.neighbors.map(n=>{const latitude=coord(n.latitude,90),longitude=coord(n.longitude,180);if(latitude===null||longitude===null)throw new Error('Neighbor coordinates are required');return {id:text(n.id,100),capturedAt:stamp(n.capturedAt),latitude,longitude,preview:preview(n.preview)};})};});
  if(new Set(cases.map(c=>c.target.id)).size!==cases.length)throw new Error('Case IDs must be unique');return cases;
}
function patch(value:Record<string,unknown>):Patch{return {placeName:text(value.placeName),country:text(value.country),latitude:coord(value.latitude,90),longitude:coord(value.longitude,180)};}
function response(value:unknown):Omit<Result,'caseId'|'mode'|'roundtripMs'|'review'> {
  const v=value as Record<string,unknown>;if(!v||typeof v!=='object')throw new Error('Invalid response');
  const c=v.candidate as Record<string,unknown>|null;const r=v.raw as Record<string,unknown>|null;
  let candidate:LocationSuggestion|null=null;
  if(c){const confidence=text(c.confidence,20),evidence=text(c.evidence,30);if(!['medium','high'].includes(confidence)||!['visual','time-series'].includes(evidence)||!Array.isArray(c.supportingPhotoIds)||c.supportingPhotoIds.length>20)throw new Error('Invalid candidate');candidate={...patch(c),confidence:confidence as 'medium'|'high',precision:text(c.precision,100),reason:text(c.reason,2000),supportingPhotoIds:c.supportingPhotoIds.map((id:unknown)=>text(id,100)),evidence:evidence as 'visual'|'time-series'};}
  const raw=r?{...patch(r),confidence:text(r.confidence,30),precision:text(r.precision,100),evidence:text(r.evidence,30)}:null;
  if(typeof v.providerSeconds!=='number'||!Number.isFinite(v.providerSeconds)||typeof v.anchorCount!=='number'||!Number.isFinite(v.anchorCount))throw new Error('Invalid timing or anchor count');
  let stages:Stage[]|undefined;
  if(v.stages!==undefined){if(!Array.isArray(v.stages)||v.stages.length>10)throw new Error('Invalid stages');stages=v.stages.map((item:unknown)=>{if(!item||typeof item!=='object')throw new Error('Invalid stage');const s=item as Record<string,unknown>;if(!['light','strong'].includes(String(s.stage))||typeof s.seconds!=='number'||!Number.isFinite(s.seconds))throw new Error('Invalid stage');const result:Stage={model:text(s.model,200),stage:s.stage as Stage['stage'],seconds:s.seconds};for(const key of ['inputTokens','outputTokens'] as const){if(s[key]!==undefined){if(typeof s[key]!=='number'||!Number.isFinite(s[key])||s[key]<0)throw new Error('Invalid token count');result[key]=s[key];}}return result;});}
  let outcome:Outcome|undefined;if(v.outcome!==undefined){if(!['skipped','accepted','different','uncertain','unavailable'].includes(String(v.outcome)))throw new Error('Invalid outcome');outcome=v.outcome as Outcome;}
  return {candidate,raw,providerSeconds:v.providerSeconds,model:text(v.model,200),anchorCount:v.anchorCount,...(stages?{stages}:{}),...(outcome?{outcome}:{})};
}
export default function LocationCheck(){
  const [cases,setCases]=useState<Case[]>([]);const [results,setResults]=useState<Result[]>([]);const [running,setRunning]=useState('');const [error,setError]=useState('');const [review,setReview]=useState<{id:string;mode:Mode;patch:Patch}|null>(null);const reviewStart=useRef(0);const runningRef=useRef(false);
  async function load(file:File|undefined){if(!file)return;try{if(file.size>100_000_000)throw new Error('File is too large');const parsed=manifest(JSON.parse(await file.text()));setCases(parsed);setResults([]);setError('');}catch(e){setError(e instanceof Error?e.message:'Invalid manifest');}}
  async function execute(c:Case,mode:Mode):Promise<void>{
    setRunning(`${c.target.id} · ${mode}`);
    const start=performance.now();
    let item:Result;
    try {
      const res=await fetch('/api/ai/location-probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:c.target,neighbors:mode==='image-only'?[]:c.neighbors,mode})});
      const body:unknown=await res.json();
      if(!res.ok)throw new Error(body && typeof body==='object' && 'error' in body && typeof body.error==='string'?body.error:'Probe failed');
      item={caseId:c.target.id,mode,...response(body),roundtripMs:Math.round(performance.now()-start),review:null};
    } catch(e) {
      setError(`${c.target.id} · ${mode}: ${e instanceof Error?e.message:'Probe failed'}`);
      item={caseId:c.target.id,mode,candidate:null,raw:null,providerSeconds:0,model:'unverified',anchorCount:0,roundtripMs:Math.round(performance.now()-start),review:null,outcome:'unavailable'};
    }
    setResults(prev=>[...prev.filter(x=>x.caseId!==item.caseId||x.mode!==mode),item]);
  }
  async function run(items:{c:Case;mode:Mode}[]){if(runningRef.current)return;runningRef.current=true;setError('');try{for(const item of items)await execute(item.c,item.mode);}finally{setRunning('');runningRef.current=false;}}
  function openReview(r:Result){if(!r.candidate)return;reviewStart.current=performance.now();setReview({id:r.caseId,mode:r.mode,patch:patch(r.candidate as unknown as Record<string,unknown>)});}
  function finish(action:'saved'|'dismissed'){if(!review)return;let safePatch:Patch|null=null;try{if(action==='saved')safePatch=patch(review.patch as unknown as Record<string,unknown>);}catch(e){setError(e instanceof Error?e.message:'Invalid review');return;}const elapsedMs=Math.round(performance.now()-reviewStart.current);setResults(prev=>prev.map(r=>r.caseId===review.id&&r.mode===review.mode?{...r,review:{action,patch:safePatch,elapsedMs}}:r));setReview(null);}
  function download(){const blob=new Blob([JSON.stringify({version:1,results},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='location-check-results.json';a.click();URL.revokeObjectURL(url);}
  return <main style={{maxWidth:900,margin:'40px auto',padding:'0 20px',fontFamily:'sans-serif'}}><h1>Location check</h1><p>Load a masked manifest. Results stay in this session until downloaded.</p><label>Load manifest <input type="file" accept="application/json,.json" disabled={!!running} onChange={e=>{void load(e.target.files?.[0]);e.target.value='';}}/></label> <button data-testid="run-all" disabled={!cases.length||!!running} onClick={()=>void run(cases.flatMap((c,i)=>i%2===0?[{c,mode:'context' as const},{c,mode:'cascade' as const}]:[{c,mode:'cascade' as const},{c,mode:'context' as const}]))}>Run context and cascade for all</button> <button data-testid="download-results" disabled={!results.length} onClick={download}>Download results</button>{running&&<p role="status">Running {running}…</p>}{error&&<p role="alert">{error}</p>}{cases.map(c=><section key={c.target.id} style={{borderTop:'1px solid #ccc',padding:'20px 0'}}><h2>{c.target.id}</h2><img src={c.target.preview} alt={`Masked target ${c.target.id}`} style={{maxWidth:240,maxHeight:180,objectFit:'contain'}}/><p>{c.target.capturedAt||'No timestamp'} · {c.neighbors.length} neighbors</p>{(['context','cascade','image-only'] as Mode[]).map(mode=>{const r=results.find(x=>x.caseId===c.target.id&&x.mode===mode);return <div key={mode} style={{margin:'12px 0'}}><button data-testid={`run-${mode}-${c.target.id}`} disabled={!!running} onClick={()=>void run([{c,mode}])}>Run {mode}</button> {r&&<><span> {r.candidate?[r.candidate.placeName,r.candidate.country].filter(Boolean).join(', ')||'Coordinates suggested':'No reviewable candidate'} · {r.providerSeconds.toFixed(1)}s provider · {(r.roundtripMs/1000).toFixed(1)}s total · {r.anchorCount} anchors</span>{r.candidate&&<button data-testid={mode==='context'?`review-${c.target.id}`:`review-${mode}-${c.target.id}`} onClick={()=>openReview(r)}>Review {mode} result</button>}{r.review&&<small> {r.review.action} · {(r.review.elapsedMs/1000).toFixed(1)}s</small>}{r.outcome&&<span> · {r.outcome}</span>}<details><summary>Result details</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify({candidate:r.candidate,raw:r.raw,model:r.model,stages:r.stages,outcome:r.outcome},null,2)}</pre></details></>}</div>;})}</section>)}{review&&<div role="dialog" aria-modal="true" aria-label={`Review ${review.mode} result`} style={{position:'fixed',inset:0,background:'#0008',display:'grid',placeItems:'center'}}><form style={{background:'white',padding:24,display:'grid',gap:12,minWidth:300}} onSubmit={e=>{e.preventDefault();finish('saved');}}><h2>Review {review.mode} result</h2>{(['placeName','country','latitude','longitude'] as const).map(key=><label key={key}>{key} <input name={key} type={key==='latitude'||key==='longitude'?'number':'text'} step={key==='latitude'||key==='longitude'?'any':undefined} min={key==='latitude'?-90:key==='longitude'?-180:undefined} max={key==='latitude'?90:key==='longitude'?180:undefined} value={review.patch[key]??''} onChange={e=>setReview({...review,patch:{...review.patch,[key]:key==='latitude'||key==='longitude'?(e.target.value===''?null:Number(e.target.value)):e.target.value}})}/></label>)}<div><button type="submit">Save review</button> <button type="button" onClick={()=>finish('dismissed')}>Dismiss</button> <button type="button" onClick={()=>setReview(null)}>Cancel</button></div></form></div>}</main>;
}
