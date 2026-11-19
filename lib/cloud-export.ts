import { defaultAccountId, readStore, storage } from './cloud-store';

const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export async function exportRoute(request:Request,path:string[]):Promise<Response> {
  if(request.method!=='GET'||!path[1])return Response.json({error:'Not found'},{status:404});
  const store=await readStore(),recap=store.recaps.find(r=>r.id===path[1]&&r.accountId===defaultAccountId);
  if(!recap)throw new Error('Recap not found');
  const photos=recap.photoIds.map(id=>store.photos.find(p=>p.id===id&&p.accountId===defaultAccountId&&!p.deletedAt)).filter(p=>!!p);
  if(!photos.length)throw new Error('No active photos remain in this recap');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({version:'cloud-v2',recap,photos:photos.map(p=>({id:p.id,sha256:p.sha256}))})));
  const snapshotHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const scene={recap,photos:photos.map(p=>({id:p.id,src:`/api/media/${encodeURIComponent(p.id)}?variant=thumb`})),width:1400,height:900,snapshotHash};
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Atlas-Snapshot':snapshotHash};
  const format=new URL(request.url).searchParams.get('format')||'html';
  if(format==='scene')return Response.json(scene,{headers});
  if(format!=='html')return Response.json({error:'Use the recap download controls to render PNG or MP4 in your browser.'},{status:400,headers});
  const images=await Promise.all(photos.slice(0,6).map(async (p, i)=>{const object=await storage().get(p.thumbnailPath);if(!object)throw new Error('A recap photo could not be loaded');const bytes=new Uint8Array(await object.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return `<img alt="Photo ${i + 1}" src="data:${object.httpMetadata?.contentType||'image/jpeg'};base64,${btoa(binary)}">`;}));
  const label=recap.theme==='data'?'PLACES & PHOTOS':recap.theme==='story'?'PHOTO STORY':'TRAVEL RECAP';
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="atlas-snapshot" content="${snapshotHash}"><title>${escape(recap.title)}</title><style>*{box-sizing:border-box}body{margin:0;background:#e8e4d9;color:#283d3b;font-family:Arial,sans-serif}.scene{max-width:1400px;min-height:900px;margin:auto;padding:48px 5%;background:#f4f0e7}.label{font-size:18px;font-weight:600;color:#496e6b;letter-spacing:.06em}h1{font-size:48px;line-height:1.15;margin:34px 0 26px;max-height:112px;overflow:hidden}p{color:#596c68;font-size:22px;line-height:1.4;margin:0 0 30px;max-height:94px;overflow:hidden}.photos{display:grid;grid-template-columns:repeat(${Math.min(3,images.length)},1fr);gap:14px;height:400px}.photos img{width:100%;height:100%;min-height:0;object-fit:cover}.count{font-size:18px;margin-top:32px;color:#496e6b}.highlights{font-size:18px;line-height:1.45;margin-top:24px}@media(max-width:600px){.scene{min-height:100vh;padding:30px 6%}h1{font-size:34px}.photos{height:350px;grid-template-columns:repeat(2,1fr)}p{font-size:18px}}</style></head><body><main class="scene"><div class="label">${label}</div><h1>${escape(recap.title)}</h1><p>${escape(recap.summary)}</p><div class="photos">${images.join('')}</div><div class="count">${photos.length} photos${photos.length>6?' · showing 6':''}</div><div class="highlights">${recap.highlights.map(escape).join(' · ')}</div></main></body></html>`;
  const disposition: Record<string,string> = new URL(request.url).searchParams.has('preview') ? {} : {'Content-Disposition':`attachment; filename="travel-recap-${snapshotHash.slice(0,12)}.html"`};
  return new Response(html,{headers:{...headers,...disposition,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"}});
}
