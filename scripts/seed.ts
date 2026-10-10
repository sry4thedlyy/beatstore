import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Database, SqlConnection } from "../src/server/db/connection";
import {
  demoProducts,
  exclusiveTerms,
  freeTerms,
  kitTerms,
  paidTerms,
  projectRequirements,
} from "./demo-data";
import { assetDirectory, generateDemoAssets } from "./generate-demo-assets";

async function insertFile(
  tx: SqlConnection,
  key: string,
  kind: string,
  contentType: string,
) {
  const bytes = await readFile(path.join(assetDirectory, key));
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const { rows: existing } = await tx.query<{ id: string; checksum: string }>(
    "SELECT id, checksum FROM files WHERE bucket = 'local-demo' AND object_key = $1",
    [key],
  );
  if (existing[0]) {
    if (existing[0].checksum !== checksum)
      throw new Error(
        `Demo asset changed: ${key}. Use a new key for a new file version.`,
      );
    return existing[0].id;
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO files (bucket, object_key, original_name, content_type, size_bytes, checksum, kind, status)
    VALUES ('local-demo', $1, $2, $3, $4, $5, $6, 'READY') RETURNING id`,
    [key, path.basename(key), contentType, bytes.length, checksum, kind],
  );
  return rows[0].id;
}

export async function seedDemo(db: Database) {
  await generateDemoAssets();
  await db.transaction(async (tx) => {
    const terms: Record<string, string> = {};
    for (const [kind, body] of Object.entries({
      FREE_MP3: freeTerms,
      MP3: paidTerms,
      WAV: paidTerms,
      STEMS: paidTerms,
      EXCLUSIVE: exclusiveTerms,
      DRUMKIT: kitTerms,
    })) {
      const parameters = ["MP3", "WAV", "STEMS"].includes(kind)
        ? { trackCount: 1, streamsPerPlatform: 500000 }
        : kind === "EXCLUSIVE"
          ? {
              royaltyBasis: "net_streaming",
              period: "calendar_quarter",
              paymentDeadlineDays: 15,
            }
          : {};
      await tx.query(
        "INSERT INTO terms_versions (kind, version, body, parameters) VALUES ($1, 'demo-v1', $2, $3) ON CONFLICT (kind, version) DO NOTHING",
        [kind, body, JSON.stringify(parameters)],
      );
      const { rows } = await tx.query<{ id: string }>(
        "SELECT id FROM terms_versions WHERE kind = $1 AND version = 'demo-v1'",
        [kind],
      );
      terms[kind] = rows[0].id;
    }
    for (const product of demoProducts) {
      const { rows: exists } = await tx.query(
        "SELECT id FROM products WHERE id = $1",
        [product.id],
      );
      if (exists.length) continue; // Seed never resets edited demo products or user data.
      const cover = await insertFile(
        tx,
        `${product.slug}/cover.jpg`,
        "COVER",
        "image/jpeg",
      );
      const thumbnail = await insertFile(
        tx,
        `${product.slug}/thumbnail.jpg`,
        "THUMBNAIL",
        "image/jpeg",
      );
      const preview = await insertFile(
        tx,
        `${product.slug}/preview.mp3`,
        "PREVIEW",
        "audio/mpeg",
      );
      const isBeat = product.type === "BEAT";
      await tx.query(
        `INSERT INTO products (id, type, title, description, status, discount_percent, cover_file_id,
        thumbnail_file_id, preview_file_id, duration_seconds, authors, bpm, musical_key, royalty_percent, project_requirements)
        VALUES ($1,$2,$3,$4,'PUBLISHED',$5,$6,$7,$8,16,$9,$10,$11,$12,$13)`,
        [
          product.id,
          product.type,
          product.title,
          product.description,
          product.discount,
          cover,
          thumbnail,
          preview,
          isBeat ? product.authors : null,
          isBeat ? product.bpm : null,
          isBeat ? product.musicalKey : null,
          isBeat ? product.royalty : null,
          isBeat ? projectRequirements : null,
        ],
      );
      const offers = isBeat
        ? [
            { kind: "MP3", price: 100000, file: preview },
            {
              kind: "WAV",
              price: 200000,
              file: await insertFile(
                tx,
                `${product.slug}/beat.wav`,
                "WAV",
                "audio/wav",
              ),
            },
            {
              kind: "STEMS",
              price: 300000,
              file: await insertFile(
                tx,
                `${product.slug}/stems.zip`,
                "STEMS",
                "application/zip",
              ),
            },
            {
              kind: "EXCLUSIVE",
              price: product.exclusivePrice,
              file: await insertFile(
                tx,
                `${product.slug}/project.zip`,
                "PROJECT",
                "application/zip",
              ),
            },
          ]
        : [
            {
              kind: "DRUMKIT",
              price: product.price,
              file: await insertFile(
                tx,
                `${product.slug}/drumkit.zip`,
                "DRUMKIT",
                "application/zip",
              ),
            },
          ];
      for (const offer of offers) {
        await tx.query(
          "INSERT INTO offers (product_id, kind, base_price_kopecks, file_id, terms_version_id) VALUES ($1,$2,$3,$4,$5)",
          [product.id, offer.kind, offer.price, offer.file, terms[offer.kind]],
        );
      }
    }
  });
}
