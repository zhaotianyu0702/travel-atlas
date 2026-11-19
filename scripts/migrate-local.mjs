import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const source=resolve(process.argv[2]||'../travel-atlas');
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdout.write('Ready for private migration credentials on stdin (input is hidden).\n');
const input=await new Promise((resolve,reject)=>{
 let line='';
 process.stdin.on('data',chunk=>{
  line+=chunk.toString();
  if(line.includes('\n')){
   process.stdin.pause();
   if(process.stdin.isTTY)process.stdin.setRawMode(false);
   try{resolve(JSON.parse(line.slice(0,line.indexOf('\n'))));}
   catch{reject(new Error('Invalid migration credentials'));}
  }
 });
});
const origin=new URL(input.origin).origin;
if(origin!=='https://example.invalid')throw new Error('Unexpected migration destination');
const base=new URL('/api/admin/migrate',origin);
const headers={'OAI-Sites-Authorization':`Bearer ${input.siteToken}`,'X-Atlas-Migration-Key':input.migrationSecret};
async function call(url,options={}){const response=await fetch(url,{...options,headers:{...headers,...options.headers},redirect:'error'});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`Migration failed (${response.status}): ${data.error||'Unexpected response'}`);return data;}
const before=await call(base);if(before.trips||before.photos||before.recaps)throw new Error('Destination contains data; migration will not overwrite it');
const db=new DatabaseSync(resolve(source,'data/atlas.sqlite'),{readOnly:true});let store;try{store=JSON.parse(db.prepare('SELECT json FROM workspace WHERE id=1').get().json);}finally{db.close();}
if(store.accounts.length!==1||store.accounts[0].id!=='local')throw new Error('Choose the intended profile before migration');
let uploaded=0;
for(const photo of store.photos){
 for(const [kind,path,mime] of [['original',photo.originalPath,photo.mimeType],['thumb',photo.thumbnailPath,'image/jpeg']]){
  const bytes=await readFile(path),sha256=createHash('sha256').update(bytes).digest('hex');
  if(kind==='original'&&sha256!==photo.sha256)throw new Error('Original photo does not match its recorded checksum');
  const url=new URL(base);url.searchParams.set('id',photo.id);url.searchParams.set('kind',kind);
  const result=await call(url,{method:'PUT',headers:{'Content-Type':mime,'X-Content-Sha256':sha256},body:bytes});
  if(result.sha256!==sha256||result.bytes!==bytes.length)throw new Error('Uploaded photo failed verification');
  uploaded++;
 }
 photo.originalPath=`originals/${photo.id}`;photo.thumbnailPath=`thumbnails/${photo.id}`;
}
for(const job of store.jobs)if(['running','queued'].includes(job.status)){job.status='failed';job.error='The job did not finish before migration. Please retry.';}
const result=await call(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'workspace',store})});
console.log(JSON.stringify({migrated:true,uploadedObjects:uploaded,...result}));
