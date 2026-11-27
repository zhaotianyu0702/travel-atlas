import { defaultAccountId, readStore, storage } from "./cloud-store";
import { buildRecapScene } from "./recap-story";
import { renderRecapHtml } from "./recap-html";

const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
import { stripImageMetadata } from "./recap-image";

function base64(bytes: Uint8Array): string {
  let result = "";
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size)
    result += String.fromCharCode(...bytes.subarray(i, i + size));
  return btoa(result);
}
export async function exportRoute(
  request: Request,
  path: string[],
): Promise<Response> {
  if (request.method !== "GET" || !path[1])
    return Response.json({ error: "Not found" }, { status: 404 });
  const format = new URL(request.url).searchParams.get("format") ?? "html";
  if (format !== "scene" && format !== "html")
    return Response.json(
      { error: "Use the recap download controls to render PNG or MP4 in your browser." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  const store = await readStore(),
    recap = store.recaps.find(
      (r) => r.id === path[1] && r.accountId === defaultAccountId,
    );
  if (!recap) throw new Error("Recap not found");
  const ownerPhotos = store.photos.filter(
    p => p.accountId === defaultAccountId && !p.deletedAt,
  );
  const photos = recap.photoIds
    .map((id) =>
      ownerPhotos.find((p) => p.id === id),
    )
    .filter((p) => !!p);
  if (!photos.length) throw new Error("No active photos remain in this recap");
  const scene = buildRecapScene(recap, ownerPhotos, "");
  const photosById = new Map(photos.map(photo => [photo.id, photo]));
  // Hash what the renderers actually receive, not mutable record bookkeeping.
  // Include the stored display object's version because the source hash alone
  // does not identify its thumbnail or optimized derivative.
  const media = await Promise.all(scene.photos.map(async scenePhoto => {
    const photo = photosById.get(scenePhoto.id);
    if (!photo) throw new Error("A recap photo could not be loaded");
    const useOriginal = photo.storageMode === "optimized" && photo.mimeType === "image/jpeg";
    const object = await storage().head(useOriginal ? photo.originalPath : photo.thumbnailPath);
    if (!object) throw new Error("A recap photo could not be loaded");
    return { id: photo.id, version: object.etag, size: object.size, contentType: object.httpMetadata?.contentType ?? null };
  }));
  const { recap: sceneRecap, snapshotHash: _snapshotHash, ...visibleScene } = scene;
  void _snapshotHash;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        version: "cloud-v7",
        scene: { ...visibleScene, recap: { title: sceneRecap.title, summary: sceneRecap.summary, cut: sceneRecap.cut } },
        media,
      }),
    ),
  );
  const snapshotHash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  scene.snapshotHash = snapshotHash;
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Atlas-Snapshot": snapshotHash,
  };
  if (format === "scene") return Response.json(scene, { headers });
  let total = 0;
  for (const scenePhoto of scene.photos) {
    const photo = photosById.get(scenePhoto.id)!;
    const useOriginal =
      photo.storageMode === "optimized" && photo.mimeType === "image/jpeg";
    const object = await storage().get(
      useOriginal ? photo.originalPath : photo.thumbnailPath,
    );
    if (!object) throw new Error("A recap photo could not be loaded");
    total += object.size;
    if (total > MAX_EXPORT_BYTES)
      throw new Error(
        "Recap is too large to export as one HTML file (16 MiB image limit). Select fewer photos and try again.",
      );
    const type = useOriginal
      ? "image/jpeg"
      : object.httpMetadata?.contentType || "image/jpeg";
    const bytes = stripImageMetadata(
      new Uint8Array(await object.arrayBuffer()),
      type,
    );
    scenePhoto.src = `data:${type};base64,${base64(bytes)}`;
  }
  const html = renderRecapHtml(scene);
  const disposition: Record<string, string> = new URL(
    request.url,
  ).searchParams.has("preview")
    ? {}
    : {
        "Content-Disposition": `attachment; filename="travel-recap-${snapshotHash.slice(0, 12)}.html"`,
      };
  return new Response(html, {
    headers: {
      ...headers,
      ...disposition,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}
