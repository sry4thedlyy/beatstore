import "server-only";
import path from "node:path";
import type { Database } from "../db/connection";
import { localMediaPath, type MediaFile } from "../media";
import { LOCAL_BUCKETS } from "./config";
import { MissingObjectError, type YandexStorage } from "./yandex";

// Run offline. Only locations change; IDs, checksums, purchased snapshots and local originals are retained.
export async function importLocalFiles(
  db: Database,
  storage: YandexStorage,
  pathForFile = localMediaPath,
) {
  const { rows } = await db.query<MediaFile>(
    "SELECT * FROM files WHERE status='READY' AND bucket=ANY($1::text[]) ORDER BY id",
    [LOCAL_BUCKETS],
  );
  let imported = 0;
  for (const file of rows) {
    const ext = path.extname(file.object_key);
    const ref = storage.reference(
      "imports",
      `${file.id}${/^\.[a-z0-9]{1,8}$/i.test(ext) ? ext : ".bin"}`,
    );
    let found = false;
    try {
      const existing = await storage.head(ref);
      if (
        existing.size !== Number(file.size_bytes) ||
        existing.checksum !== file.checksum
      )
        throw new Error(
          "Import target has different content. Local reference retained.",
        );
      found = true;
    } catch (e) {
      if (!(e instanceof MissingObjectError)) throw e;
    }
    if (!found)
      await storage.putFile(
        ref,
        pathForFile(file),
        Number(file.size_bytes),
        file.content_type,
        file.checksum,
        file.id,
      );
    const result = await db.query(
      `UPDATE files SET bucket=$4,object_key=$5 WHERE id=$1 AND status='READY' AND bucket=$2 AND object_key=$3 AND checksum=$6 RETURNING id`,
      [
        file.id,
        file.bucket,
        file.object_key,
        ref.bucket,
        ref.object_key,
        file.checksum,
      ],
    );
    if (!result.rows.length)
      throw new Error(
        "File reference changed during import. Stop the application before retrying.",
      );
    imported++;
  }
  return { imported };
}
