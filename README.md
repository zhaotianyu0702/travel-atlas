# Travel Atlas

Travel Atlas is a trip-centered travel album for importing photos, exploring them on a globe and map, organizing galleries, and creating editable recaps. This repository contains the midterm source. [Watch the midterm demo](https://zhaotianyu0702.github.io/travel-atlas/) · [Source repository](https://github.com/zhaotianyu0702/travel-atlas)

## Midterm status

The application includes Atlas, Trips and Recaps views, photo import and editing, map pins and routes, and self-contained HTML recap export. Optional AI features suggest metadata or highlights for review. Suggestions do not automatically become confirmed photo facts. PNG and MP4 exports depend on browser support; the current MP4 is a three-second still recap. Location inference can abstain when evidence is insufficient and needs further evaluation; no human usability study is claimed. Personal photos and workspace records are not included.

## Setup and build

Node.js 24 or newer is recommended. The project requires a local Cloudflare D1 database and R2 bucket; its Vite configuration creates local binding declarations. The deployed application additionally relies on Sites-provided identity and Cloudflare services. A clean clone does not connect to the original deployment or contain its data.

```sh
cp .openai/hosting.example.json .openai/hosting.json
npm ci
npm run typecheck
npm test
npm run build
npx wrangler d1 execute DB --local --persist-to .wrangler/state --config dist/server/wrangler.json --file drizzle/0000_aromatic_cassandra_nova.sql
npm start
```

The D1 command initializes a fresh local database once; do not rerun it against an existing database. `npm start` uses the built Worker and local storage. `npm run dev` starts the development server with local mock authentication. Production requires separately configured D1, R2 and authentication bindings. AI features require an `OPENAI_API_KEY` configured as a server-side secret and incur provider usage; do not put a key in source or browser code. `ATLAS_MODEL` can select the server model. AI is optional for the core workflow. The migration utility contains a placeholder destination and is only relevant to a separately configured migration.

## Architecture and resources

React with Vinext runs on Cloudflare Workers. D1 stores workspace records, R2 stores photos and thumbnails, and Drizzle defines the schema. Browser-side code prepares images and exports recaps; OpenAI Responses API powers optional, explicitly requested AI tasks. The map combines D3 Geo, Three.js, MapLibre and Natural Earth geometry, with globe-to-Equal-Earth transitions. Other libraries include exifr, heic-to, mp4-muxer and the UI dependencies listed in `package.json`.

See [location evaluation protocol](docs/location-evaluation.md), [photo optimization measurement](docs/photo-optimization-measurement.md), and [proposal feedback](docs/proposal-feedback.md). The included synthetic evaluator fixtures check calculations, not real-world model accuracy. Source code and configuration do not include the original hosted deployment's identity, credentials or private media.
