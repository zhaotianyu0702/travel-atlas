#!/usr/bin/env node
// Offline evaluator: no photos, network requests, or model invocation.
import { readFileSync } from 'node:fs';

function fail(message) { throw new Error(message); }
function read(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { fail(`Cannot read JSON ${path}: ${e.message}`); } }
function entries(value, name) { if (!Array.isArray(value) || !value.length) fail(`${name} must be a non-empty array`); return value; }
function index(rows, name) {
  const map = new Map();
  for (const row of entries(rows, name)) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim()) fail(`${name}: each row requires a non-empty id`);
    if (map.has(row.id)) fail(`${name}: duplicate id ${row.id}`);
    map.set(row.id, row);
  }
  return map;
}
function coordinate(row, allowNull, label) {
  const { latitude: lat, longitude: lon } = row;
  if (allowNull && lat === null && lon === null) return null;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90 || typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) fail(`${label}: invalid coordinate pair`);
  return [lat, lon];
}
function distanceKm(a, b) {
  const rad = x => x * Math.PI / 180;
  const dlat = rad(b[0] - a[0]), dlon = rad(b[1] - a[1]);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dlon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
const rate = (n, d) => d ? n / d : null;
const round = n => n === null ? null : Math.round(n * 1000) / 1000;
function median(xs) { if (!xs.length) return null; const a = [...xs].sort((x,y)=>x-y), mid = Math.floor(a.length/2); return a.length % 2 ? a[mid] : (a[mid-1]+a[mid])/2; }
function evaluate(truthRows, predictionRows) {
  const truth = index(truthRows, 'truth'), predictions = index(predictionRows, 'predictions');
  for (const id of predictions.keys()) if (!truth.has(id)) fail(`predictions: unexpected id ${id}`);
  const details = [], distances = [];
  let abstained = 0, cluePoor = 0, cluePoorAbstained = 0, claimsWithoutCoordinates = 0;
  for (const [id, t] of truth) {
    const ground = coordinate(t, false, `truth ${id}`);
    if (typeof t.cluePoor !== 'boolean') fail(`truth ${id}: cluePoor must be boolean`);
    const p = predictions.get(id); if (!p) fail(`predictions: missing id ${id}; explicitly record abstentions`);
    if (!['claim', 'abstain'].includes(p.status)) fail(`prediction ${id}: status must be claim or abstain`);
    const point = coordinate(p, true, `prediction ${id}`);
    if (typeof p.placeName !== 'string' || typeof p.country !== 'string') fail(`prediction ${id}: placeName and country must be strings`);
    if (p.status === 'abstain' && (point || p.placeName.trim() || p.country.trim())) fail(`prediction ${id}: abstention cannot contain a location claim`);
    if (p.status === 'claim' && !point && !p.placeName.trim() && !p.country.trim()) fail(`prediction ${id}: claim must contain a location`);
    if (t.cluePoor) { cluePoor++; if (p.status === 'abstain') cluePoorAbstained++; }
    if (p.status === 'abstain') abstained++;
    let km = null;
    if (point) { km = distanceKm(ground, point); distances.push(km); }
    else if (p.status === 'claim') claimsWithoutCoordinates++;
    details.push({ id, cluePoor: t.cluePoor, status: p.status, errorKm: round(km) });
  }
  const n = truth.size;
  return { count: n, abstained, abstentionRate: round(rate(abstained,n)), claims: n-abstained,
    coordinateClaims: distances.length, coordinateCoverage: round(rate(distances.length,n)), claimsWithoutCoordinates,
    meanErrorKm: round(rate(distances.reduce((a,b)=>a+b,0),distances.length)), medianErrorKm: round(median(distances)),
    within1Km: {count:distances.filter(d=>d<=1).length, rateAmongCoordinateClaims:round(rate(distances.filter(d=>d<=1).length,distances.length))},
    within10Km: {count:distances.filter(d=>d<=10).length, rateAmongCoordinateClaims:round(rate(distances.filter(d=>d<=10).length,distances.length))},
    cluePoor: {count:cluePoor, abstained:cluePoorAbstained, abstentionRate:round(rate(cluePoorAbstained,cluePoor)), claims:cluePoor-cluePoorAbstained}, details };
}
function timing(rows, truthIds) {
  const cases = index(rows, 'timings');
  if (cases.size !== truthIds.size || [...cases.keys()].some(id=>!truthIds.has(id))) fail('timings: IDs must match the held-out set exactly');
  const totals = {manual:0, ai:0}, detail=[];
  for (const [id, row] of cases) {
    const phases = { manual:['inspectSeconds','researchSeconds','editSeconds'], ai:['inspectSeconds','requestWaitSeconds','reviewSeconds','editSeconds'] };
    const item={id};
    for (const mode of ['manual','ai']) {
      if (!row[mode] || typeof row[mode] !== 'object') fail(`timings ${id}: missing ${mode}`);
      let sum=0;
      for (const phase of phases[mode]) { const v=row[mode][phase]; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(`timings ${id}: ${mode}.${phase} must be a nonnegative number`); sum+=v; }
      item[`${mode}Seconds`]=round(sum); totals[mode]+=sum;
    }
    detail.push(item);
  }
  return {count:cases.size, manualTotalSeconds:round(totals.manual), aiTotalSeconds:round(totals.ai), manualMeanSeconds:round(totals.manual/cases.size), aiMeanSeconds:round(totals.ai/cases.size), meanPairedDifferenceSeconds:round((totals.ai-totals.manual)/cases.size), details:detail};
}
try {
  const args=process.argv.slice(2);
  if (args.length !== 2 && args.length !== 3) fail('Usage: node scripts/evaluate-location.mjs TRUTH.json PREDICTIONS.json [TIMINGS.json]');
  const truth=read(args[0]), predictions=read(args[1]);
  const result={location:evaluate(truth,predictions), timing:args[2] ? timing(read(args[2]),index(truth,'truth')) : {status:'not measured'}};
  console.log(JSON.stringify(result,null,2));
} catch (error) { console.error(`Evaluation error: ${error.message}`); process.exitCode=1; }
