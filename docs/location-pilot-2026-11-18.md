# Held-out Travel Atlas pilot — November 18, 2026

**The model abstained on all three clue-poor photos. It returned a pin on only one of six photos, 574 m from the camera GPS. The AI-assisted workflow took longer on every paired case in this agent-operated pilot.**

This pilot addresses the requested masked-GPS and whole-task comparison in [John’s feedback](https://github.com/onexi/ps06/blob/2155fe8730dd0c8200d5136e19f2f06a2bde0787/zhaotianyu0702/feedback_John.md) and the clue-poor cases in [Abel’s feedback](https://github.com/onexi/ps06/blob/1016aee72d4ad54cc25d5c826d4d054036fe7a2c/zhaotianyu0702/feedback_abel.md).

## Sample and procedure

- Source: the owner’s Apple Photos, from the same South Africa and Namibia trip as the development pilot. Excluded dates used in the original test and drew a small, seeded sample (20261118) within the visible eligible Photos results. This was not uniform sampling across the whole trip. A screen for past filenames, exact SHA-256 matches and near-duplicates (64-bit difference hash, Hamming distance ≤5, prior thumbnails and current batch) found no matches among the 12 stills exported. Six were frozen before inference: four from Namibia and two from South Africa, with three designated clue-poor (ordinary food or scenery without a distinctive location cue).
- Each input was an opaque-ID JPEG rendered from the original. Tests checked the JPEG contained no EXIF, GPS, XMP, IPTC or ICC data. No filename, time, neighboring photos, trip labels, captions or coordinates entered either arm. Camera GPS from the original EXIF was held separately until outputs were frozen. Camera location is the reference for distance, and may differ from the position of a sign, landmark or mountain in the image.
- One independent model request per image, using the shipped prompt, schema and validator at source baseline `913a969`, with `gpt-6.1-terra` and high reasoning. The [local probe](../scripts/run-masked-probe.ts) used the Codex subscription transport rather than the deployed Responses API. Each wait includes CLI launch, actual model request and validation; it does not measure production API or browser latency.
- Two Codex operators each did three cases without a suggestion and the other three with one, with no operator seeing the same photo twice. The manual arm could inspect the image and use optional text-only lookup. The assisted arm additionally saw the model candidate and reviewed, corrected or rejected it under the same evidence standard. Both stopped when they saved a correction or explicitly left it unknown using the app’s own photo-patch validation against a disposable record. No change was made to the owner's photo library or production records. These were **agent operators, not a human usability test**.
- Timing used a monotonic clock: manual ran from image display to saved decision; assisted adds observed request-to-result time and timed image inspection, suggestion review, optional research and saved decision. The two measured AI segments were run separately, so scheduling gaps between them are excluded. All six paired cases were scored, including abstentions.

## Location and time

| Stage | Pins / 6 | Named place only | No location | Pin error versus camera GPS |
| --- | ---: | ---: | ---: | --- |
| Raw product suggestion | 1 | 2 | 3 | 574 m (one pin) |
| After manual correction | 3 | 0 | 3 | 27–63 m (three pins) |
| After AI-assisted review | 2 | 0 | 4 | 27–52 m (two pins) |

All three low-clue cases were left unresolved in all stages. The label-only suggestions are excluded from kilometer error. One of those cases stayed unresolved after AI-assisted review, while the manual operator located it. Differences in pin errors are conditional on different coverage. This small same-trip sample does not establish accuracy on other trips.

| Case | Clues | Manual, s | AI wait, s | AI review and save, s | AI total, s | Raw AI | Final manual | Final assisted |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| A | Distinctive | 11.6 | 14.1 | 10.0 | 24.1 | Name only | 58 m | Unresolved |
| B | Weak | 5.6 | 14.2 | 5.4 | 19.7 | Unresolved | Unresolved | Unresolved |
| C | Weak | 5.3 | 15.6 | 5.2 | 20.7 | Unresolved | Unresolved | Unresolved |
| D | Distinctive | 13.8 | 14.1 | 11.3 | 25.4 | 574 m | 63 m | 52 m |
| E | Distinctive | 10.5 | 11.8 | 16.5 | 28.3 | Name only | 27 m | 27 m |
| F | Weak | 10.1 | 13.8 | 8.9 | 22.7 | Unresolved | Unresolved | Unresolved |

Mean: **9.5 s manual vs. 23.5 s assisted**, including 13.9 s waiting and 9.6 s reviewing and saving. The assisted workflow was slower by **14.0 s per image** on average, with **0/6** faster. On this sample, wait time drove the difference; review and saving alone took about as long as the manual workflow.

Photos, GPS references, source IDs, place labels and credentials are omitted from this report.
