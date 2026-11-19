/** Local masked-image probe. This uses Codex subscription transport, not the production Responses API. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildModelInput } from '../lib/ai-input';
import { suggestionSchema, validateSuggestion } from '../lib/ai-schema';
import type { Photo, Trip } from '../lib/types';

const usage = `Usage: npx tsx scripts/run-masked-probe.ts --id <opaque-hex-id> --image <masked.jpg> [--timestamp <ISO-8601>]

Runs one masked JPEG using the product prompt/schema with Codex subscription fallback
(gpt-6.1-terra, high reasoning), not the production Responses endpoint.
The optional timestamp must be matched to this photo; no other metadata is accepted.
The JPEG must have no metadata segments (a plain JFIF header is permitted).
Result JSON is written to stdout; provider_wait_ms measures the CLI process wall time.`;

function parseArgs(args: string[]) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(usage); process.exit(0); }
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--id', '--image', '--timestamp'].includes(key) || !value || value.startsWith('--') || values[key] !== undefined) throw new Error('Invalid arguments. Use --help.');
    values[key] = value;
  }
  if (!/^[a-f0-9]{16,64}$/.test(values['--id'] ?? '') || !values['--image']) throw new Error('Provide --image and an opaque lowercase hexadecimal --id of 16–64 characters.');
  const timestamp = values['--timestamp'] ?? null;
  if (timestamp && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)))) throw new Error('Timestamp must be a valid ISO-8601 date and time.');
  return { id: values['--id'], image: values['--image'], timestamp };
}

// Walk marker segments including between progressive scans; reject embedded metadata.
function assertMaskedJpeg(data: Buffer) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error('Input is not a JPEG.');
  let i = 2, inScan = false, ended = false;
  while (i < data.length) {
    if (inScan) {
      while (i < data.length && data[i] !== 0xff) i++;
      if (i >= data.length) break;
      while (i < data.length && data[i] === 0xff) i++;
      const code = data[i++];
      if (code === 0x00 || (code >= 0xd0 && code <= 0xd7)) continue;
      i -= 2; inScan = false;
    }
    if (data[i++] !== 0xff) throw new Error('Malformed JPEG marker.');
    while (i < data.length && data[i] === 0xff) i++;
    const marker = data[i++];
    if (marker === 0xd9) { ended = true; break; }
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) throw new Error('Malformed JPEG marker.');
    if (i + 2 > data.length) throw new Error('Truncated JPEG.');
    const length = data.readUInt16BE(i);
    if (length < 2 || i + length > data.length) throw new Error('Truncated JPEG segment.');
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      const plainJfif = marker === 0xe0 && length === 16 && data.subarray(i + 2, i + 7).equals(Buffer.from('JFIF\0')) && data[i + 14] === 0 && data[i + 15] === 0;
      if (!plainJfif) throw new Error('JPEG contains metadata or application segments; provide a stripped image.');
    }
    i += length;
    if (marker === 0xda) inScan = true;
  }
  if (!ended || i !== data.length) throw new Error('JPEG is incomplete or has trailing data.');
}

async function main() {
  const { id, image, timestamp } = parseArgs(process.argv.slice(2));
  const bytes = await readFile(image);
  assertMaskedJpeg(bytes);
  const trip: Trip = { id:'trip', accountId:'probe', title:'', notes:'', startDate:null, endDate:null, createdAt:'', updatedAt:'' };
  const photo: Photo = { id, accountId:'probe', tripId:'trip', fileName:'', mimeType:'image/jpeg', width:0, height:0, sha256:'', capturedAt:timestamp, latitude:null, longitude:null, placeName:'', country:'', notes:'', locationSource:'unknown', confirmed:false, originalPath:'', thumbnailPath:'', metadata:{capturedAt:timestamp, latitude:null, longitude:null}, createdAt:'' };
  const { prompt } = buildModelInput(trip, [photo], { targetPhotoIds:[id] });
  const dir = await mkdtemp(join(tmpdir(), 'atlas-masked-probe-'));
  try {
    const imageFile = join(dir, 'image.jpg'), schemaFile = join(dir, 'schema.json'), outputFile = join(dir, 'result.json');
    await Promise.all([writeFile(imageFile, bytes, {mode:0o600}), writeFile(schemaFile, JSON.stringify(suggestionSchema), {mode:0o600})]);
    const args = ['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','-s','read-only','-m','gpt-6.1-terra','-c','model_reasoning_effort="high"','-c','forced_login_method="chatgpt"','-c','mcp_servers={}','--disable','shell_tool','--disable','unified_exec','--output-schema',schemaFile,'--output-last-message',outputFile,'--json','-i',imageFile,'-'];
    const start = performance.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('codex', args, {cwd:dir, stdio:['pipe','ignore','pipe']});
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Codex process failed (${code}): ${stderr}`)));
      child.stdin.on('error', () => {}); child.stdin.end(prompt);
    });
    const providerWaitMs = Math.round(performance.now() - start);
    const result = validateSuggestion(JSON.parse(await readFile(outputFile, 'utf8')), [photo]);
    const candidate = result.placeCandidates.find(c => c.photoId === id);
    const claim = !!candidate && candidate.precision !== 'unknown' && !!(candidate.placeName.trim() || candidate.country.trim() || candidate.latitude !== null);
    console.log(JSON.stringify({case_id:id, transport:'codex-subscription fallback', model:'gpt-6.1-terra', reasoning:'high', provider_wait_ms:providerWaitMs, location_outcome:claim ? 'claim' : 'abstain', location_candidate:candidate ?? null, result}, null, 2));
  } finally { await rm(dir, {recursive:true, force:true}); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Probe failed'); process.exitCode = 1; });
