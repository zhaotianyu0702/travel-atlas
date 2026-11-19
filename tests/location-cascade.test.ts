import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

test('location probe routes scene checks through the cascade and interpolates only supported matches', async () => {
  const entry = `import { locationProbeRoute } from ${JSON.stringify(resolve('lib/cloud-location.ts'))};
let queue=[], calls=[];
globalThis.fetch=async (url, init)=>{
  if (!String(url).startsWith('https://api.openai.com/v1/responses')) throw new Error('Unexpected network call');
  const body=JSON.parse(init.body); calls.push(body);
  const decision=queue.shift(); if(!decision) throw new Error('Unexpected provider call');
  return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(decision)}]}]});
};
export default {async fetch(req) {try {
 const path=new URL(req.url).pathname;
 if(path==='/configure'){queue=await req.json();calls=[];return Response.json({ok:true});}
 if(path==='/calls') return Response.json(calls);
 if(path==='/location-probe') return await locationProbeRoute(req);
 return new Response('Not found',{status:404});
} catch(e){return Response.json({error:String(e)},{status:500});}}};`;
  const built = await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',conditions:['workerd','worker','browser'],external:['cloudflare:workers']});
  const mf = new Miniflare({modules:[{type:'ESModule',path:'worker.mjs',contents:built.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],bindings:{OPENAI_API_KEY:'test-only',ATLAS_MODEL:'strong-test-model'}});
  try {
    const post = (path:string, body:unknown) => mf.dispatchFetch('http://local/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const decode = async (response:Awaited<ReturnType<typeof mf.dispatchFetch>>) => { assert.equal(response.status,200,await response.clone().text()); return await response.json() as any; };
    // Minimal synthetic JPEG markers, with no embedded metadata.
    const preview = 'data:image/jpeg;base64,'+Buffer.from([255,216,255,218,0,2,255,217]).toString('base64');
    const target = {id:'target',capturedAt:'2026-03-01T12:00:00Z',preview};
    const neighbors = [
      {id:'before',capturedAt:'2026-03-01T11:50:00Z',latitude:42,longitude:-71,preview},
      {id:'after',capturedAt:'2026-03-01T12:10:00Z',latitude:42.002,longitude:-71,preview},
    ];
    const match = {verdict:'match',reasonCode:'stable-cues',evidencePhotoIds:['before','after'],reason:'Same structure visible.'};
    const different = {verdict:'different',reasonCode:'different-location',evidencePhotoIds:['before'],reason:'Incompatible structure.'};
    const competing = {verdict:'uncertain',reasonCode:'competing-cues',evidencePhotoIds:['before'],reason:'One matching structure and conflicting cues.'};
    const run = async (decisions:unknown[], inputNeighbors=neighbors) => {
      await decode(await post('configure',decisions));
      const result=await decode(await post('location-probe',{mode:'cascade',target,neighbors:inputNeighbors}));
      const calls=await decode(await mf.dispatchFetch('http://local/calls'));
      return {result,calls};
    };
    const accepted=await run([match]);
    assert.equal(accepted.result.outcome,'accepted');
    assert.equal(accepted.calls.length,1);
    assert.equal(accepted.calls[0].model,'gpt-4.1-mini-2025-04-14');
    assert.ok(Math.abs(accepted.result.candidate.latitude-42.001)<1e-9);
    assert.equal(accepted.result.candidate.longitude,-71);
    assert.equal(accepted.result.candidate.confidence,'medium');
    assert.deepEqual(accepted.result.candidate.supportingPhotoIds,['before','after']);
    const rejected=await run([different]);
    assert.equal(rejected.result.outcome,'different'); assert.equal(rejected.result.candidate,null); assert.equal(rejected.calls.length,1);
    const tight=[{...neighbors[0],capturedAt:'2026-03-01T11:59:55Z'}, {...neighbors[1],capturedAt:'2026-03-01T12:00:16Z',latitude:42.00001}];
    const verifiedConflict=await run([different,match],tight);
    assert.equal(verifiedConflict.result.outcome,'accepted'); assert.equal(verifiedConflict.calls.length,2);
    const turned={verdict:'match',reasonCode:'compatible-angle',evidencePhotoIds:['before'],reason:'Same rock formations from one angle; other frame points inland.'};
    const verifiedTurn=await run([different,turned],tight);
    assert.equal(verifiedTurn.result.outcome,'accepted'); assert.equal(verifiedTurn.calls.length,2);
    assert.match(verifiedTurn.result.candidate.reason,/One matching view/);
    await decode(await post('configure',[turned]));
    const unverifiedTurn=await post('location-probe',{mode:'cascade',target,neighbors:tight});
    assert.equal(unverifiedTurn.status,500);
    const confirmedDifference=await run([different,different],tight);
    assert.equal(confirmedDifference.result.candidate,null); assert.equal(confirmedDifference.calls.length,2);
    const generic={verdict:'uncertain',reasonCode:'generic-or-unusable',evidencePhotoIds:[],reason:'No identifiable overlap.'};
    const rejectedGeneric=await run([generic],tight);
    assert.equal(rejectedGeneric.result.candidate,null); assert.equal(rejectedGeneric.calls.length,1);
    const skipped=await run([],neighbors.slice(0,1));
    assert.equal(skipped.result.outcome,'skipped'); assert.equal(skipped.result.candidate,null); assert.equal(skipped.calls.length,0);
    const fallback=await run([competing,match]);
    assert.equal(fallback.result.outcome,'accepted'); assert.equal(fallback.calls.length,2);
    assert.deepEqual(fallback.calls.map((c:any)=>c.model),['gpt-4.1-mini-2025-04-14','strong-test-model']);
    assert.deepEqual(fallback.result.stages.map((s:any)=>s.stage),['light','strong']);
  } finally { await mf.dispose(); }
});
