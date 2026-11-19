'use client';
import {useState} from 'react';
import type {Photo} from '@/lib/types';
import {photoCaptureDate} from '@/lib/photo-time';
export default function TripGallery({photos,onOpen,onFocus,groupIds}:{photos:Photo[];onOpen:(p:Photo,list:Photo[])=>void;onFocus:(p:Photo)=>void;groupIds:string[] | null}) {
 const [mode,setMode]=useState<'gallery'|'timeline'|'places'>('gallery');const items=groupIds?photos.filter(p=>groupIds.includes(p.id)):photos;
 const groups=mode==='gallery'?[['All photos',items] as const]:Array.from(items.reduce((m,p)=>{const key=mode==='timeline'?(photoCaptureDate(p)||'Date unknown'):(p.placeName||p.country||'Place unknown');m.set(key,[...(m.get(key)||[]),p]);return m;},new Map<string,Photo[]>()).entries()).sort(([a],[b])=>mode==='timeline'?a.localeCompare(b):a.localeCompare(b));
 return <><div className="gallery-tabs">{(['gallery','timeline','places'] as const).map(x=><button key={x} className={mode===x?'active':''} onClick={()=>setMode(x)}>{x[0].toUpperCase()+x.slice(1)}</button>)}</div>{groups.map(([name,list])=><div className="trip-photo-group" key={name}>{mode!=='gallery'&&<strong>{name}</strong>}<div className="photo-grid">{list.map(p=><div className="trip-photo-tile" key={p.id}><button className="photo-card" onClick={()=>onOpen(p,items)} aria-label={`Open ${p.fileName}`}><img src={`/api/media/${p.id}?variant=thumb`} alt=""/>{p.favorite&&<span className="trip-heart">♥</span>}</button>{p.latitude!==null && p.longitude!==null && <button className="focus-photo" onClick={()=>onFocus(p)} aria-label={`Show ${p.fileName} on map`}>◎</button>}</div>)}</div></div>)}{!items.length&&<p className="muted">No photos in this group.</p>}</>;
}
