import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { getDatabase, type Database } from "./db/connection";
import type { CurrentUser } from "./auth/session";
import { assertAdministrator } from "./catalog/admin";

export interface MediaFile {
  id: string;
  bucket: string;
  object_key: string;
  content_type: string;
  size_bytes: string;
  checksum: string;
}

export async function getPublicMedia(
  id: string,
  connection?: Database,
): Promise<MediaFile | null> {
  const db = connection ?? (await getDatabase());
  const { rows } = await db.query<MediaFile>(
    `SELECT f.id, f.bucket, f.object_key, f.content_type, f.size_bytes, f.checksum FROM files f
    WHERE f.id = $1 AND f.status = 'READY' AND f.kind IN ('COVER','THUMBNAIL','PREVIEW','MP3')
      AND f.content_type IN ('image/jpeg','image/png','image/webp','audio/mpeg') AND EXISTS (SELECT 1 FROM products p
      WHERE p.status = 'PUBLISHED' AND (p.cover_file_id = f.id OR p.thumbnail_file_id = f.id OR p.preview_file_id = f.id))`,
    [id],
  );
  return rows[0] ?? null;
}

export function localMediaPath(file: MediaFile): string {
  if (!["local-demo", "local-upload", "local-document"].includes(file.bucket))
    throw new Error("Storage provider is not configured for this file");
  const root = path.resolve(
    /*turbopackIgnore: true*/ file.bucket === "local-demo"
      ? ".data/demo-assets"
      : file.bucket === "local-document"
        ? ".data/documents"
        : ".data/uploads",
  );
  const filename = path.resolve(root, file.object_key);
  if (!filename.startsWith(root + path.sep))
    throw new Error("Invalid object key");
  return filename;
}
export async function readLocalMedia(file: MediaFile): Promise<Buffer> {
  return readFile(localMediaPath(file));
}
export async function getAdminMedia(
  user: CurrentUser,
  id: string,
  connection?: Database,
): Promise<MediaFile | null> {
  const db = connection ?? (await getDatabase());
  await assertAdministrator(user, db);
  const { rows } = await db.query<MediaFile>(
    `SELECT f.id,f.bucket,f.object_key,f.content_type,f.size_bytes,f.checksum FROM files f
    WHERE f.id=$1 AND f.status='READY' AND f.kind IN ('COVER','THUMBNAIL','PREVIEW','MP3') AND EXISTS
    (SELECT 1 FROM products p WHERE p.cover_file_id=f.id OR p.thumbnail_file_id=f.id OR p.preview_file_id=f.id)`,
    [id],
  );
  return rows[0] ?? null;
}
export async function mediaResponse(
  request: Request,
  file: MediaFile,
  head = false,
  privateMedia = false,
  downloadName?: string,
  pathForFile = localMediaPath,
): Promise<Response> {
  let filename: string;
  const size = Number(file.size_bytes);
  try {
    filename = pathForFile(file);
    if ((await stat(filename)).size !== size)
      throw new Error("Incomplete file");
  } catch {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const headers = new Headers({
    "Content-Type": file.content_type,
    "Accept-Ranges": "bytes",
    "Cache-Control": privateMedia ? "private, no-store" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    ETag: `"${file.checksum}"`,
  });
  if (downloadName) {
    const rawName = downloadName.replaceAll("\\", "/").split("/").pop()!;
    const name = Array.from(rawName)
      .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? "_" : c))
      .join("");
    const ascii =
      name.replace(/[^a-zA-Z0-9_. -]/g, "_").slice(0, 180) || "download";
    headers.set(
      "Content-Disposition",
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    );
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  }
  if (request.headers.get("if-none-match") === headers.get("ETag"))
    return new Response(null, { status: 304, headers });
  const ifRange = request.headers.get("if-range");
  const rangeHeader =
    head || (ifRange && ifRange !== headers.get("ETag"))
      ? null
      : request.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (rangeHeader && !range) {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set(
    "Content-Length",
    String(range ? range.end - range.start + 1 : size),
  );
  if (range)
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  const stream = head
    ? null
    : (Readable.toWeb(
        createReadStream(filename, range ?? undefined),
      ) as ReadableStream<Uint8Array>);
  return new Response(stream, { status: range ? 206 : 200, headers });
}

export function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return null;
  return { start, end };
}
