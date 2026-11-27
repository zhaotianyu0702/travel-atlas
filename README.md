# Travel Atlas

Travel Atlas turns a folder of travel photos into an interactive trip. Explore your trips on a globe, open a trip to see where each photo was taken, and follow the route as you scroll the timeline. Build a recap by choosing a story direction and reviewing the photos before exporting it.

[MIT 1.125 final presentation (3:30)](https://drive.google.com/file/d/168ESlrIqKobN2bHOTkgibjweN1jdBIFO/view) · [Midpoint presentation](https://zhaotianyu0702.github.io/travel-atlas/)

## Run from a clean clone

Use Node.js 24 or later and a recent desktop Chrome. The local app starts with an empty library. Use photos you can share with the local app; JPEGs with GPS metadata make the map workflow easy to try.

```sh
git clone https://github.com/zhaotianyu0702/travel-atlas.git
cd travel-atlas
cp .openai/hosting.example.json .openai/hosting.json
npm ci
npm run typecheck
npm test
npm run build
npx wrangler d1 execute DB --local --persist-to .wrangler/state --config dist/server/wrangler.json --file drizzle/0000_aromatic_cassandra_nova.sql
npm run dev
```

Open http://localhost:5173. The sign-in button uses a local development identity. Run the D1 initialization once per fresh local database. Create a trip, add photos, and select **Generate recap** from the trip. Use the preview to confirm the selection and export as HTML, PNG, or MP4. Interactive HTML works offline. Chrome must support H.264 WebCodecs for MP4 and AAC encoding for soundtrack export.

The core workflow runs without an AI key. For model-backed options, configure `OPENAI_API_KEY` as a server secret and set `ATLAS_MODEL` as a server runtime variable. Keep secret values out of Git. A hosted instance requires its own Sites identity, Cloudflare D1 and R2 bindings, and deployment settings.

## Architecture and dependencies

- **Import.** The browser reads GPS, time and orientation before resizing. It hashes the source for duplicate detection and uploads bounded batches of optimized files and thumbnails. React and Vinext run on Cloudflare Workers. D1 and Drizzle hold the trip records, and private R2 holds the media.
- **Map and timeline.** Three.js and D3 Geo render the globe-to-map transition with Natural Earth geometry. MapLibre uses OpenFreeMap tiles built from OpenStreetMap data. Map and timeline selection stay linked within a trip. Route lines are estimates between capture locations.
- **AI and recaps.** OpenAI Responses can check candidate locations in the background and suggest story directions using photo previews, dates and places. Location recommendations can leave a photo unresolved or ask the user to accept a suggestion. The browser renders the saved photo selection, basemap, labels, and video soundtrack. See the [music source and license notices](public/recap-audio/NOTICE.txt) and the [MapLibre worker notice](public/atlas-maplibre-worker.NOTICE.txt). Image and video libraries include exifr, heic-to, and mp4-muxer. Other dependencies are listed in `package.json`.

## Validation and limitations

The [masked-GPS pilot](docs/location-pilot-2026-11-18.md) included six held-out photos. The model proposed one pin, 574 m from recorded GPS, and abstained on all three low-clue photos. The paired agent-operated workflow averaged 9.5 s manually and 23.5 s with AI, including waiting and review. The small pilot used agents as operators and measures only those six cases. Capture metadata can be incomplete, estimated routes can diverge from the actual journey, and browser decoding or export support varies. Check recommendations and review the selected photos before sharing an export.

See the [evaluation protocol](docs/location-evaluation.md), [photo optimization measurement](docs/photo-optimization-measurement.md), and [proposal feedback audit](docs/proposal-feedback.md). The source distribution includes synthetic test fixtures. Personal photo libraries, credentials and hosted workspace data are excluded. AI tools assisted with implementation and testing.
