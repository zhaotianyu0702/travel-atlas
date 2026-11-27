import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importPhotos } from '../lib/browser-import';

test('prepares later photos while serial uploads run and continues after an upload failure', async () => {
  const originalBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  let decoded = 0, active = 0, maxActive = 0;
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstUpload = new Promise<void>(resolve => { firstStarted = resolve; });
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const requests: string[][] = [];
  Object.assign(globalThis, {
    createImageBitmap: async () => {
      decoded++; active++; maxActive = Math.max(active, maxActive);
      return { width: 100, height: 100, close: () => { active--; } };
    },
    document: { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (callback: (value: Blob) => void) => callback(new Blob(['jpeg'], { type: 'image/jpeg' })) }) },
    fetch: async (_url: string, init: RequestInit) => {
      const names = (init.body as FormData).getAll('files').map(value => (value as File).name);
      requests.push(names);
      if (requests.length === 1) { firstStarted(); await gate; }
      if (requests.length <= 3) throw new Error('network error');
      return { ok: true, json: async () => ({ imported: JSON.parse((init.body as FormData).get('sources') as string), duplicates: 0, errors: [] }) };
    },
  });
  try {
    const files = Array.from({ length: 25 }, (_, i) => new File([`image${i}`], `${i}.jpg`, { type: 'image/jpeg' }));
    const promise = importPhotos(files, 'trip');
    await firstUpload;
    assert.deepEqual(requests[0], ['0.jpg', '1.jpg']);
    // Let compression advance without allowing the first request to finish.
    for (let i = 0; i < 100 && decoded < 20; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(decoded >= 20, `only ${decoded} images decoded while upload was pending`);
    assert.equal(requests.length, 1);
    assert.ok(maxActive <= 2);
    releaseFirst();
    const result = await promise;
    assert.deepEqual(result.errors.map(error => error.fileName), ['0.jpg', '1.jpg']);
    assert.deepEqual(requests.slice(0,3), [requests[0], requests[0], requests[0]]);
    assert.deepEqual([requests[0],...requests.slice(3)].flat(), files.map(file => file.name));
    assert.equal(active, 0);
  } finally {
    Object.assign(globalThis, { createImageBitmap: originalBitmap, document: originalDocument, fetch: originalFetch });
  }
});

test('keeps capture time and GPS with original and optimized storage', async () => {
  // Minimal TIFF with EXIF wall time, offset and GPS coordinates.
  const bytes = Buffer.alloc(198);
  bytes.write('II'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    bytes.writeUInt16LE(tag, at); bytes.writeUInt16LE(type, at + 2); bytes.writeUInt32LE(count, at + 4); bytes.writeUInt32LE(value, at + 8);
  };
  bytes.writeUInt16LE(2, 8); entry(10, 0x8769, 4, 1, 38); entry(22, 0x8825, 4, 1, 68);
  bytes.writeUInt16LE(2, 38); entry(40, 0x9003, 2, 20, 122); entry(52, 0x9011, 2, 7, 142);
  bytes.writeUInt16LE(4, 68); entry(70, 1, 2, 2, 0x4e); entry(82, 2, 5, 3, 150); entry(94, 3, 2, 2, 0x57); entry(106, 4, 5, 3, 174);
  bytes.write('2024:05:06 12:34:56\0', 122); bytes.write('-04:00\0', 142);
  for (const [i, number] of [42, 30, 0, 71, 15, 0].entries()) { bytes.writeUInt32LE(number, 150 + i * 8); bytes.writeUInt32LE(1, 154 + i * 8); }
  const originalBitmap = globalThis.createImageBitmap, originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  const captured: { sources: Array<Record<string, unknown>>; file: File }[] = [];
  Object.assign(globalThis, {
    createImageBitmap: async () => ({ width: 100, height: 100, close() {} }),
    document: { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (callback: (value: Blob) => void) => callback(new Blob(['jpeg'], { type: 'image/jpeg' })) }) },
    fetch: async (_url: string, init: RequestInit) => {
      const body = init.body as FormData;
      captured.push({ sources: JSON.parse(body.get('sources') as string), file: body.get('files') as File });
      return { ok: true, json: async () => ({ imported: JSON.parse((init.body as FormData).get('sources') as string), duplicates: 0, errors: [] }) };
    },
  });
  try {
    const file = new File([bytes], 'photo.tiff', { type: 'image/tiff' });
    await importPhotos([file], 'trip', { keepOriginals: true });
    await importPhotos([file], 'trip');
    for (const { sources } of captured) {
      assert.equal(sources[0].latitude, 42.5); assert.equal(sources[0].longitude, -71.25);
      assert.deepEqual(sources[0].time, { capturedAt: '2024-05-06T16:34:56.000Z', timezoneKnown: true, offsetMinutes: -240, source: 'DateTimeOriginal', localDateTime: '2024-05-06T12:34:56' });
    }
    assert.equal(captured[0].sources[0].mode, 'original'); assert.equal(captured[0].file.size, bytes.length);
    assert.equal(captured[1].sources[0].mode, 'optimized'); assert.equal(captured[1].file.type, 'image/jpeg');
  } finally {
    Object.assign(globalThis, { createImageBitmap: originalBitmap, document: originalDocument, fetch: originalFetch });
  }
});

test('verifies candidate hashes once before decoding and falls back on stale hints or lookup failure', async () => {
  const originalBitmap=globalThis.createImageBitmap, originalDocument=globalThis.document, originalFetch=globalThis.fetch;
  const sha=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
  const known=await sha('existing'), absent=await sha('stale');
  let hashes=0, decodes=0, encodes=0, uploads=0, checks=0, mode='success';
  const progress: {completed:number;prepared:number;total:number}[]=[];
  const file=(data:string,name:string)=>{const f=new File([data],name,{type:'image/jpeg'});const read=f.arrayBuffer.bind(f);f.arrayBuffer=async()=>{hashes++;return read();};return f;};
  Object.assign(globalThis,{
    createImageBitmap:async()=>{decodes++;return {width:100,height:100,close(){}};},
    document:{createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}}),toBlob:(cb:(b:Blob)=>void)=>{encodes++;cb(new Blob(['jpeg'],{type:'image/jpeg'}));}})},
    fetch:async(url:string,init:RequestInit)=>{
      if(String(url).includes('/photo-hashes')){checks++;assert.equal(url,'/api/trips/a%2Fb/photo-hashes');if(mode==='fail')throw Error('offline');return {ok:true,json:async()=>({hashes:[known]})};}
      uploads++; const body=init.body as FormData, sources=JSON.parse(body.get('sources') as string);
      return {ok:true,json:async()=>({imported:sources.map((x:{sha256:string})=>({sha256:x.sha256})),duplicates:0,errors:[]})};
    },
  });
  try {
    const result=await importPhotos([file('existing','one.jpg'),file('existing','two.jpg'),file('fresh','fresh.jpg')],'a/b',{knownSourceHashes:[known],onProgress:p=>progress.push(p)});
    assert.deepEqual([hashes,decodes,encodes,uploads,checks],[3,1,2,1,1]);
    assert.equal(result.duplicates,2);assert.equal(result.imported.length,1);assert.equal(result.errors.length,0);
    assert.deepEqual(progress.at(-1),{completed:3,prepared:3,total:3,phase:'uploading'});
    const stale=await importPhotos([file('stale','same-name.jpg')],'a/b',{knownSourceHashes:[absent]});
    assert.equal(stale.duplicates,0);assert.equal(stale.imported.length,1);assert.deepEqual([decodes,uploads,checks],[2,2,2]);
    mode='fail';const fallback=await importPhotos([file('existing','same-name.jpg')],'a/b',{knownSourceHashes:[known]});
    assert.equal(fallback.duplicates,0);assert.equal(fallback.imported.length,1);assert.deepEqual([decodes,uploads,checks],[3,3,3]);
  } finally {Object.assign(globalThis,{createImageBitmap:originalBitmap,document:originalDocument,fetch:originalFetch});}
});

test('skips a later copy only after an earlier upload confirms it', async()=>{
 const originalBitmap=globalThis.createImageBitmap,originalDocument=globalThis.document,originalFetch=globalThis.fetch;
 let decodes=0,uploads=0,checks=0;
 Object.assign(globalThis,{
  createImageBitmap:async()=>{decodes++;return {width:100,height:100,close(){}};},
  document:{createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}}),toBlob:(cb:(b:Blob)=>void)=>cb(new Blob(['jpeg'],{type:'image/jpeg'}))})},
  fetch:async(url:string,init:RequestInit)=>{if(String(url).includes('/photo-hashes')){checks++;throw Error('unexpected lookup');}uploads++;const sources=JSON.parse((init.body as FormData).get('sources') as string);return {ok:true,json:async()=>({imported:sources.map((s:{sha256:string})=>({sha256:s.sha256})),duplicates:0,errors:[]})};},
 });
 try {
  const files=['a','b','c','d','e','f','a'].map((s,i)=>new File([s],i+'.jpg',{type:'image/jpeg'}));
  const result=await importPhotos(files,'trip');
  assert.equal(result.duplicates,1);assert.equal(result.imported.length,6);assert.equal(decodes,6);assert.equal(uploads,2);assert.equal(checks,0);
 } finally {Object.assign(globalThis,{createImageBitmap:originalBitmap,document:originalDocument,fetch:originalFetch});}
});

test('a later copy can retry when the first upload fails', async()=>{
 const originalBitmap=globalThis.createImageBitmap,originalDocument=globalThis.document,originalFetch=globalThis.fetch;
 let uploads=0,decodes=0;
 Object.assign(globalThis,{
  createImageBitmap:async()=>{decodes++;return {width:100,height:100,close(){}};},
  document:{createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}}),toBlob:(cb:(b:Blob)=>void)=>cb(new Blob(['jpeg'],{type:'image/jpeg'}))})},
  fetch:async(_url:string,init:RequestInit)=>{uploads++;if(uploads<=3)throw Error('offline');const sources=JSON.parse((init.body as FormData).get('sources') as string);return {ok:true,json:async()=>({imported:sources.map((s:{sha256:string})=>({sha256:s.sha256})),duplicates:0,errors:[]})};},
 });
 try {
  const files=['a','b','c','d','e','f','a'].map((s,i)=>new File([s],i+'.jpg',{type:'image/jpeg'}));
  const result=await importPhotos(files,'trip');
  assert.equal(result.duplicates,0);assert.equal(result.imported.length,5);assert.equal(result.errors.length,2);assert.equal(decodes,7);assert.equal(uploads,4);
 } finally {Object.assign(globalThis,{createImageBitmap:originalBitmap,document:originalDocument,fetch:originalFetch});}
});

test('retries transient responses and reports server-confirmed duplicates after a lost response',async()=>{
 const bitmap=globalThis.createImageBitmap,document=globalThis.document,fetch=globalThis.fetch;
 let calls=0;const saved=new Set<string>();const progress:number[]=[];
 Object.assign(globalThis,{
  createImageBitmap:async()=>({width:100,height:100,close(){}}),
  document:{createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}}),toBlob:(cb:(b:Blob)=>void)=>cb(new Blob(['jpeg'],{type:'image/jpeg'}))})},
  fetch:async(_url:string,init:RequestInit)=>{calls++;const sources=JSON.parse((init.body as FormData).get('sources') as string) as {sha256:string}[];
   if(calls===1){for(const s of sources)saved.add(s.sha256);throw Error('response lost');}
   if(calls===2)return {ok:false,status:503,json:async()=>({error:'temporarily unavailable'})};
   return {ok:true,json:async()=>({imported:sources.filter(s=>!saved.has(s.sha256)),duplicates:sources.filter(s=>saved.has(s.sha256)).length,errors:[]})};},
 });
 try{const files=['first','second'].map((x,i)=>new File([x],i+'.jpg',{type:'image/jpeg'}));const r=await importPhotos(files,'t',{onProgress:p=>progress.push(p.completed)});
  assert.equal(calls,3);assert.equal(saved.size,2);assert.equal(r.duplicates,2);assert.equal(r.imported.length,0);assert.equal(r.errors.length,0);assert.ok(progress.every(n=>n<=2));assert.equal(progress.at(-1),2);
 }finally{Object.assign(globalThis,{createImageBitmap:bitmap,document,fetch});}
});

test('splits only HTTP 413 and does not retry business errors or split a single file',async()=>{
 const bitmap=globalThis.createImageBitmap,document=globalThis.document,fetch=globalThis.fetch;
 let mode='split';const sizes:number[]=[];
 Object.assign(globalThis,{
  createImageBitmap:async()=>({width:100,height:100,close(){}}),
  document:{createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}}),toBlob:(cb:(b:Blob)=>void)=>cb(new Blob(['jpeg'],{type:'image/jpeg'}))})},
  fetch:async(_url:string,init:RequestInit)=>{const sources=JSON.parse((init.body as FormData).get('sources') as string);sizes.push(sources.length);
   if(mode==='business')return {ok:false,status:400,json:async()=>({error:'Invalid trip'})};
   if(mode==='single'||sources.length>1)return {ok:false,status:413,json:async()=>({error:'Too large'})};
   return {ok:true,json:async()=>({imported:sources,duplicates:0,errors:[]})};},
 });
 try{const files=['a','b'].map((x,i)=>new File([x],i+'.jpg',{type:'image/jpeg'}));
  const split=await importPhotos(files,'t');assert.deepEqual(sizes,[2,1,1]);assert.equal(split.imported.length,2);assert.equal(split.errors.length,0);
  sizes.length=0;mode='business';const rejected=await importPhotos(files,'t');assert.deepEqual(sizes,[2]);assert.deepEqual(rejected.errors.map(x=>x.error),['Invalid trip','Invalid trip']);
  sizes.length=0;mode='single';const one=await importPhotos([files[0]],'t');assert.deepEqual(sizes,[1]);assert.equal(one.errors[0].error,'Too large');
 }finally{Object.assign(globalThis,{createImageBitmap:bitmap,document,fetch});}
});
