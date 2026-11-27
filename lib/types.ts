import type { StoredRecapCutJob } from './cloud-recap-cuts';
import type { RecapCut } from "./recap-cut";

export interface Account { id: string; name: string; createdAt: string }
export interface Trip { id: string; accountId: string; title: string; startDate: string | null; endDate: string | null; notes: string; createdAt: string; updatedAt: string; coverPhotoId?: string | null; highlightPhotoIds?: string[]; highlightAnalyzedCount?: number; estimatedRoute?: EstimatedRoute | null }
export interface EstimatedRoute { provider: 'OSRM'; generatedAt: string; segments: { fromPhotoId:string; toPhotoId:string; coordinates:[number, number][] }[]; distanceMeters: number; durationSeconds: number; waypointPhotoIds: string[] }
export interface Photo {
  id: string; accountId: string; tripId: string; fileName: string; mimeType: string; width: number; height: number; sha256: string;
  capturedAt: string | null; latitude: number | null; longitude: number | null; placeName: string; country: string; notes: string;
  locationSource: 'exif' | 'photos' | 'user' | 'unknown'; confirmed: boolean; originalPath: string; thumbnailPath: string;
  favorite?: boolean; deletedAt?: string | null;
  /** Derived in the private workspace response; not persisted. */
  recapVisualDescription?: string;
  storageMode?: 'optimized' | 'original';
  timeSource?: 'exif' | 'photos' | 'user' | 'unknown';
  timeMetadata?: { capturedAt: string | null; timezoneKnown: boolean; offsetMinutes: number | null; source: 'DateTimeOriginal' | 'CreateDate' | 'GPSDateTime' | 'unknown'; localDateTime: string | null };
  metadata: { capturedAt: string | null; latitude: number | null; longitude: number | null }; createdAt: string;
  libraryMetadata?: { source: 'apple-photos'; assetId: string; capturedAt: string; latitude: number | null; longitude: number | null; exportKind: string; query: string; seed: number };
}
export interface Recap {
  id: string; accountId: string; title: string; summary: string; highlights: string[]; photoIds: string[];
  tripIds: string[]; startDate: string | null; endDate: string | null; place: string;
  cut?: RecapCut | null;
  theme: 'mixed' | 'data' | 'story'; createdAt: string; updatedAt: string;
}
export interface AiSuggestion {
  title: string; summary: string; highlights: string[]; selectedPhotoIds: string[];
  groups: { name: string; photoIds: string[]; reason: string }[];
  placeCandidates: { photoId: string; placeName: string; country: string; latitude: number | null; longitude: number | null; confidence: 'low' | 'medium' | 'high'; reason: string; precision?: 'country' | 'region' | 'locality' | 'landmark' | 'unknown'; supportingPhotoIds?: string[] }[];
  timeCandidates?: { photoId: string; dateFrom: string | null; dateTo: string | null; confidence: 'low' | 'medium' | 'high'; reason: string; supportingPhotoIds: string[] }[];
  issues?: { photoId: string; kind: 'no-subject' | 'blurred' | 'missing-location' | 'missing-time' | 'conflicting-context' | 'insufficient-evidence'; message: string }[];
}
export interface AiJob {
  id: string; accountId: string; tripId: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; model: string; provider: string;
  inputHash: string; result: AiSuggestion | null; error: string | null; durationMs: number | null; createdAt: string; updatedAt: string;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number }; analyzedPhotoIds?: string[]; totalPhotoCount?: number; targetPhotoIds?: string[];
  scope?: {photoIds: string[]; title: string};
  responseId?: string; submissionStartedAt?: string;
}
export interface Workspace { account: Account; accounts: Account[]; trips: Trip[]; photos: Photo[]; recaps: Recap[]; jobs: AiJob[]; model: string; provider: string }
export interface Store {
  accounts: Account[]; trips: Trip[]; photos: Photo[]; recaps: Recap[]; jobs: AiJob[];
  locationJobs?:StoredLocationJob[];
  highlightJobs?:StoredHighlightJob[];
  recapCutJobs?:StoredRecapCutJob[];
  routeRequests?: { tripId:string; sourceKey:string; startedAt:number; status:'running'|'done'|'failed' }[];
  routeLastRequestAt?:number;
  pendingMediaDeletes?:string[];
}

export interface LocationSuggestion {
  placeName:string;country:string;latitude:number|null;longitude:number|null;
  confidence:'medium'|'high';precision:string;reason:string;supportingPhotoIds:string[];
  evidence:'time-series'|'visual';
}
export interface LocationJob {
  id:string;tripId:string;photoId:string;status:'running'|'queued'|'succeeded'|'failed';
  candidate:LocationSuggestion|null;reviewed?:'saved'|'dismissed';durationMs:number|null;
}
export interface StoredLocationJob extends LocationJob {
  sourceHash:string;createdAt:number;responseId?:string;pipeline?:'cascade-v2'|'cascade-v3'|'cascade-v4';
}

export interface HighlightJob {
  id:string;tripId:string;status:'running'|'succeeded'|'failed';
  analyzedCount:number;totalCount:number;failedBatches:number;elapsedMs?:number;
}
export interface HighlightBatch {
  photoIds:string[];status:'queued'|'running'|'succeeded'|'failed';
  responseId?:string;selected?:string[];claimedAt?:number;
}
export interface StoredHighlightJob extends HighlightJob {
  sourceKey:string;createdAt:number;model:string;batches:HighlightBatch[];superseded?:boolean;
  sourceCutoff?:number; pipeline?:string; finishedAt?:number;
}
