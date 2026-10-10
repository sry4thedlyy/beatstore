import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDatabase, type Database } from "./db/connection";

interface MediaFile {
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
    WHERE f.id = $1 AND f.status = 'READY' AND EXISTS (SELECT 1 FROM products p
      WHERE p.status = 'PUBLISHED' AND (p.cover_file_id = f.id OR p.thumbnail_file_id = f.id OR p.preview_file_id = f.id))`,
    [id],
  );
  return rows[0] ?? null;
}

export async function readLocalMedia(file: MediaFile): Promise<Buffer> {
  if (file.bucket !== "local-demo")
    throw new Error("Storage provider is not configured for this file");
  const root = path.resolve(".data/demo-assets");
  const filename = path.resolve(root, file.object_key);
  if (!filename.startsWith(root + path.sep))
    throw new Error("Invalid object key");
  return readFile(filename);
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
