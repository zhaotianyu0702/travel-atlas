declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    OPENAI_API_KEY?: string;
    ATLAS_MODEL?: string;
    ATLAS_MIGRATION_SECRET?: string;
  }
}
