# Held-out location evaluation

This is the reusable protocol. See the [November 18 real-photo pilot](location-pilot-2026-11-18.md) for measured location error and paired agent-operated correction times. The offline scorer makes no model or network calls; its bundled records are invented solely to check calculations. Human task time has not been measured.

## Freeze and mask the sample

1. Before inspecting model outputs, select a held-out set of photos with independently verifiable GPS. Exclude photos and near-duplicates used to develop prompts, tune behavior, or choose thresholds; group neighboring shots from the same scene or trip in the same split. Record selection method, exclusions and counts. Include both identifiable landmarks and ordinary clue-poor scenes; classify `cluePoor` in advance from the visible evidence, without looking at the prediction. GPS is an approximate reference, not proof of the pictured subject's exact position.
2. Keep a private manifest with opaque `id`, source and permission/provenance, trip/scene group, split, reference coordinates and how verified, `cluePoor`, and permitted contextual evidence. Keep the reference file separate from the masked input, predictions and people running the task. Preserve originals. Do not commit personal photos, reference coordinates, exports or derived private material to this repository. Public images also require documented source, license, and independent coordinate provenance. No public photo dataset is supplied here.
3. Make copies for evaluation. Strip embedded GPS and other location-bearing metadata, including EXIF/XMP/IPTC and filenames; use opaque IDs, and clear stored coordinates, place, country, location notes and location-bearing trip titles. Check both the actual image bytes and every field sent to the model/UI, including metadata and cached thumbnails. Do not merely hide the GPS in the interface. Inspect neighboring images, timestamps and trip context for leakage; either remove them or freeze and disclose them as the same permitted context for every comparable case. Nearby photos with GPS can reveal the answer. The user doing the task must not see the reference or original EXIF until all predictions are frozen. Keep a local mapping and audit one masked input per source type before running.
4. Run the frozen product/model configuration once on each case, recording version, date, inputs, context policy, failures and all outputs. Store one prediction per ID. `status: "abstain"` requires null coordinates and empty place/country; absent candidate or an unresolved candidate is an abstention. A country, region or place name is a claim even without coordinates. Preserve actual output without filling in missing coordinates. Do not treat model errors as abstentions: record failed cases and rerun under a predefined policy, or report them separately. Do not drop hard cases silently. The evaluator requires every ID, so unresolved execution failures must be resolved before computing full-set results.
5. Freeze predictions before joining the private references. For ordinary clue-poor scenes, inspect the reported claim count as a failure of the desired abstention behavior; coordinate errors alone cannot establish whether a named place is correct. Review any coarse or textual claims separately against a documented reference and avoid presenting their unmeasured correctness as accuracy.

## Input and command

Inputs are JSON arrays, one object per ID. The truth file contains `id`, numeric `latitude` and `longitude` in degrees, and boolean `cluePoor`. The predictions file contains `id`, `status` (`claim` or `abstain`), `latitude` and `longitude` (both numeric or both null), and strings `placeName` and `country`. Exact IDs are required once each. Coordinates are compared using great-circle distance (mean Earth radius 6,371.0088 km). Mean and median error and 1 km/10 km rates use only coordinate claims; coordinate coverage, abstention, non-coordinate claims and clue-poor abstention use the stated counts so selective abstention cannot masquerade as overall accuracy. Empty denominators produce `null`. Distance is to the reference point, not proof of the correct landmark. Report sample size, split/context, all these metrics and limitations together; inspect per-case errors.

```sh
node scripts/evaluate-location.mjs /private/path/truth.json /private/path/predictions.json > /private/path/location-results.json
```

To validate the evaluator using invented values only:

```sh
node scripts/evaluate-location.mjs scripts/location-evaluation-fixtures/truth.synthetic.json scripts/location-evaluation-fixtures/predictions.synthetic.json scripts/location-evaluation-fixtures/timings.synthetic.json
```

Expected: three records, one abstention, one coordinate claim at approximately 1.112 km, one non-coordinate claim, and one of two clue-poor cases abstaining. These numbers are not product performance.

## Timed manual versus AI correction

Predefine the task, target accuracy/acceptable unknown outcome, allowed research tools, stop rule, and a blinded check of the final saved result. Use the same masked inputs and permitted context. Randomize order and counterbalance conditions; independent blinded raters can perform manual and AI tasks on the same cases. If the owner performs both on the same photos, use separated sessions and counterbalanced order, disclose recognition/learning effects, and do not generalize a small personal trial. Alternatively use matched, different photos per condition and analyze those as unpaired; the optional timing calculator below is only for paired IDs. Do not expose truth or the other condition's output while a task is underway. Record cases unresolved or failed and report them, rather than timing only successes. Verify the final saved location or deliberate unknown separately against the reference; compare quality and completion alongside time.

Use a monotonic stopwatch. Start at first presentation of the masked case; stop when the participant saves a final correction or explicitly leaves it unknown. Record nonoverlapping seconds for each phase, including zero when unused:

- Manual: `inspectSeconds`, `researchSeconds`, `editSeconds` (including final save/decision).
- AI: `inspectSeconds`, `requestWaitSeconds` (request through result or failure), `reviewSeconds` (checking evidence, including any research), `editSeconds` (correction and final save/decision).

Include AI waiting and human review in total elapsed time. If a participant works on other tasks during the wait, record that fact and elapsed time; do not subtract it silently. Record interruptions and deviations separately; prescribe exclusions before inspecting outcomes. Repeat with the same stop rule and record both individual paired times and aggregate, plus the actual quality outcomes. A negative AI-minus-manual difference means less elapsed time for AI in these paired observations, not a proven general effect.

Optional timing input: a JSON array with one object per held-out ID and nested `manual` and `ai` objects with the phase keys above. All values must be nonnegative finite seconds, including explicit zeros. Supply it as the third command argument. The output gives summed phase times and the paired mean difference; the operator must measure phases and ensure they cover the full task. If no timing file is provided the output explicitly says `not measured`. The synthetic timing fixture is a format example only; owner timings remain unmeasured.
