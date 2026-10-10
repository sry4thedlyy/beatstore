import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { parseFile } from "music-metadata";
import { openPromise } from "yauzl";
import {
  CatalogError,
  STORAGE_LIMIT,
  uploadKinds,
  uploadLimits,
  type UploadKind,
} from "../../domain/catalog-editor";
import type { CurrentUser } from "../auth/session";
import { getDatabase, type Database } from "../db/connection";
import {
  assertAdministrator,
  getEditorProduct,
  lockEditableProduct,
} from "./admin";

const COVER_RESERVE = 4 * 1024 * 1024;
export function uploadDirectory(): string {
  return path.resolve(/*turbopackIgnore: true*/ ".data/uploads");
}
export function uploadSize(value: string | null, kind: UploadKind): number {
  if (!value || !/^\d{1,10}$/.test(value))
    throw new CatalogError(400, "Не указан размер файла.");
  const size = Number(value);
  if (size < 1 || size > uploadLimits[kind])
    throw new CatalogError(
      413,
      `Файл пуст или превышает ${uploadLimits[kind] / 1024 / 1024} МБ.`,
    );
  return size;
}
function filename(value: string | null, kind: UploadKind): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value ?? "");
  } catch {
    throw new CatalogError(400, "Некорректное имя файла.");
  }
  const name = decoded.replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  if (
    !name ||
    name.length > 180 ||
    Array.from(name).some((c) => c.charCodeAt(0) < 32)
  )
    throw new CatalogError(
      400,
      "Имя файла должно содержать от 1 до 180 символов.",
    );
  const ext = path.extname(name).toLowerCase();
  const valid =
    kind === "COVER"
      ? [".jpg", ".jpeg", ".png", ".webp"]
      : kind === "MP3" || kind === "PREVIEW"
        ? [".mp3"]
        : kind === "WAV"
          ? [".wav"]
          : [".zip"];
  if (!valid.includes(ext))
    throw new CatalogError(400, `Нужен файл формата ${valid.join(", ")}.`);
  return name;
}
export async function inspectZip(file: string, kind: UploadKind) {
  let zip: Awaited<ReturnType<typeof openPromise>>;
  try {
    zip = await openPromise(file, {
      autoClose: false,
      strictFileNames: true,
      validateEntrySizes: true,
    });
  } catch {
    throw new CatalogError(400, "Не удалось прочитать ZIP-архив.");
  }
  const names = new Set<string>();
  let count = 0,
    unpacked = 0,
    hasWav = false,
    hasFlp = false,
    hasRules = false;
  try {
    for await (const entry of zip.eachEntry()) {
      count++;
      unpacked += entry.uncompressedSize;
      const name = entry.fileName.toLowerCase();
      if (
        count > 10000 ||
        unpacked > 2 * 1024 * 1024 * 1024 ||
        names.has(name) ||
        entry.isEncrypted() ||
        !entry.canDecodeFileData() ||
        ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
      )
        throw new CatalogError(
          400,
          "ZIP должен быть без пароля, ссылок и повторяющихся имён, до 10 000 файлов и 2 ГБ после распаковки.",
        );
      names.add(name);
      const header = await zip.readLocalFileHeaderPromise(entry);
      if (
        header.fileDataStart + entry.compressedSize > zip.fileSize ||
        header.compressionMethod !== entry.compressionMethod ||
        !header.fileName.equals(entry.fileNameRaw) ||
        header.generalPurposeBitFlag & 1
      )
        throw new CatalogError(400, "Повреждена структура ZIP-архива.");
      if (!name.endsWith("/")) {
        hasWav ||= name.endsWith(".wav");
        hasFlp ||= name.endsWith(".flp");
        hasRules ||= name.endsWith(".txt");
      }
    }
    if (
      !count ||
      (kind === "STEMS" && !hasWav) ||
      (kind === "PROJECT" && !hasFlp) ||
      (kind === "DRUMKIT" && !hasRules)
    )
      throw new CatalogError(
        400,
        kind === "STEMS"
          ? "В ZIP дорожек должен быть WAV-файл."
          : kind === "PROJECT"
            ? "В ZIP проекта должен быть файл FL Studio (.flp)."
            : "В ZIP драмкита должен быть текстовый файл правил (.txt).",
      );
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError(400, "Повреждён ZIP-архив.");
  } finally {
    zip.close();
  }
}
async function inspectAudio(file: string, kind: UploadKind): Promise<number> {
  try {
    const { format } = await parseFile(file, {
      duration: true,
      skipCovers: true,
      skipPostHeaders: true,
    });
    const isWav = kind === "WAV";
    if (
      isWav
        ? format.container !== "WAVE"
        : format.container !== "MPEG" || !format.codec?.includes("Layer 3")
    )
      throw new Error("Wrong format");
    if (
      !format.duration ||
      !Number.isFinite(format.duration) ||
      format.duration > 60 * 60 ||
      !format.sampleRate ||
      !format.numberOfChannels
    )
      throw new Error("Invalid duration");
    return Math.max(1, Math.round(format.duration));
  } catch {
    throw new CatalogError(
      400,
      `Не удалось прочитать ${kind === "WAV" ? "WAV" : "MP3"}. Нужен аудиофайл длительностью до одного часа.`,
    );
  }
}
async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export interface UploadSource {
  stream: ReadableStream<Uint8Array>;
  size: string | null;
  name: string | null;
  revision: number;
}
export async function uploadProductFile(
  user: CurrentUser,
  id: string,
  kind: UploadKind,
  source: UploadSource,
  connection?: Database,
  root = uploadDirectory(),
) {
  const db = connection ?? (await getDatabase());
  if (!Object.hasOwn(uploadLimits, kind))
    throw new CatalogError(404, "Назначение файла не найдено.");
  const size = uploadSize(source.size, kind),
    originalName = filename(source.name, kind);
  const fileId = randomUUID(),
    key = `${fileId}${kind === "COVER" ? ".source" : path.extname(originalName).toLowerCase()}`;
  const target = path.join(root, key);
  const pendingSize = size + (kind === "COVER" ? COVER_RESERVE : 0);
  const paths = [target];
  let reserved = false,
    committed = false;
  try {
    await db.transaction(async (tx) => {
      await assertAdministrator(user, tx);
      // All upload reservations take the same table lock before summing stored versions.
      await tx.exec("LOCK TABLE files IN SHARE ROW EXCLUSIVE MODE");
      const row = await lockEditableProduct(tx, id, source.revision);
      if (!uploadKinds(row.type).includes(kind))
        throw new CatalogError(
          400,
          "Этот файл не относится к выбранному типу товара.",
        );
      const { rows } = await tx.query<{ used: string }>(
        `SELECT coalesce(sum(size_bytes),0)::text AS used FROM files WHERE status IN ('READY','PENDING')`,
      );
      if (Number(rows[0].used) + pendingSize > STORAGE_LIMIT)
        throw new CatalogError(
          413,
          "Недостаточно места: общий лимит демонстрации — 1 ГБ, включая сохраняемые версии.",
        );
      await tx.query(
        `INSERT INTO files (id,bucket,object_key,original_name,content_type,size_bytes,kind,status) VALUES ($1,'local-upload',$2,$3,'application/octet-stream',$4,$5,'PENDING')`,
        [fileId, key, originalName, pendingSize, kind],
      );
    });
    reserved = true;
    await mkdir(root, { recursive: true });
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(
          received > size
            ? new CatalogError(413, "Файл превышает заявленный размер.")
            : null,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.fromWeb(
        source.stream as import("node:stream/web").ReadableStream,
      ),
      limit,
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    if (received !== size)
      throw new CatalogError(
        400,
        "Загрузка оборвалась. Размер файла не совпадает.",
      );
    let duration: number | null = null;
    let cover: { id: string; key: string; bytes: Buffer } | undefined,
      thumbnail: typeof cover;
    let contentType: string;
    if (kind === "COVER") {
      try {
        const image = sharp(target, {
          limitInputPixels: 40_000_000,
          failOn: "warning",
        });
        const metadata = await image.metadata();
        if (
          !["jpeg", "png", "webp"].includes(metadata.format ?? "") ||
          (metadata.pages ?? 1) > 1
        )
          throw new Error("Unsupported image");
        const bytes = await image
          .rotate()
          .resize(1200, 1200, { fit: "cover" })
          .flatten({ background: "#18191c" })
          .jpeg({ quality: 88 })
          .toBuffer();
        const small = await sharp(bytes)
          .resize(480, 480)
          .jpeg({ quality: 85 })
          .toBuffer();
        if (bytes.length + small.length > COVER_RESERVE)
          throw new Error("Large output");
        cover = { id: randomUUID(), key: `${randomUUID()}.jpg`, bytes };
        thumbnail = {
          id: randomUUID(),
          key: `${randomUUID()}.jpg`,
          bytes: small,
        };
        for (const result of [cover, thumbnail]) {
          const dest = path.join(root, result.key);
          paths.push(dest);
          await writeFile(dest, result.bytes, { flag: "wx", mode: 0o600 });
        }
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        throw new CatalogError(
          400,
          "Не удалось обработать обложку. Нужен статичный JPEG, PNG или WebP до 40 мегапикселей.",
        );
      }
      contentType = "image/jpeg";
    } else if (["MP3", "PREVIEW", "WAV"].includes(kind)) {
      duration = await inspectAudio(target, kind);
      contentType = kind === "WAV" ? "audio/wav" : "audio/mpeg";
    } else {
      await inspectZip(target, kind);
      contentType = "application/zip";
    }
    const checksum = kind === "COVER" ? "" : await hashFile(target);
    await db.transaction(async (tx) => {
      await assertAdministrator(user, tx);
      await tx.exec("LOCK TABLE files IN SHARE ROW EXCLUSIVE MODE");
      await lockEditableProduct(tx, id, source.revision);
      if (cover && thumbnail) {
        for (const [result, fileKind] of [
          [cover, "COVER"],
          [thumbnail, "THUMBNAIL"],
        ] as const)
          await tx.query(
            `INSERT INTO files (id,bucket,object_key,original_name,content_type,size_bytes,checksum,kind,status)
            VALUES ($1,'local-upload',$2,$3,'image/jpeg',$4,$5,$6,'READY')`,
            [
              result.id,
              result.key,
              originalName,
              result.bytes.length,
              createHash("sha256").update(result.bytes).digest("hex"),
              fileKind,
            ],
          );
        await tx.query(
          `UPDATE products SET cover_file_id=$2,thumbnail_file_id=$3 WHERE id=$1`,
          [id, cover.id, thumbnail.id],
        );
        await tx.query("DELETE FROM files WHERE id=$1", [fileId]);
      } else {
        await tx.query(
          `UPDATE files SET content_type=$2,size_bytes=$3,checksum=$4,status='READY' WHERE id=$1`,
          [fileId, contentType, size, checksum],
        );
        if (kind === "MP3" || kind === "PREVIEW")
          await tx.query(
            `UPDATE products SET preview_file_id=$2,duration_seconds=$3 WHERE id=$1`,
            [id, fileId, duration],
          );
        if (kind !== "PREVIEW")
          await tx.query(
            `UPDATE offers SET file_id=$2 WHERE product_id=$1 AND kind=$3`,
            [id, fileId, kind === "PROJECT" ? "EXCLUSIVE" : kind],
          );
      }
      await tx.query(
        `UPDATE products SET revision=revision+1,updated_at=now() WHERE id=$1`,
        [id],
      );
    });
    committed = true;
    if (kind === "COVER") await unlink(target).catch(() => {});
    return await getEditorProduct(user, id, db);
  } catch (error) {
    if (!committed) {
      // Only random paths created by this request are removed; stored versions are retained.
      for (const file of paths) await unlink(file).catch(() => {});
      if (reserved)
        await db.query(`DELETE FROM files WHERE id=$1 AND status='PENDING'`, [
          fileId,
        ]);
    }
    if (error instanceof CatalogError) throw error;
    if (source.stream.locked || (error as Error).name === "AbortError")
      throw new CatalogError(400, "Загрузка не завершена. Попробуй ещё раз.");
    throw error;
  }
}
