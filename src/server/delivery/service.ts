import "server-only";
import {
  DeliveryError,
  type DeliveryView,
  type FreeDownloadView,
} from "../../domain/delivery";
import type { CurrentUser } from "../auth/session";
import type { Database, SqlConnection } from "../db/connection";
import { isUuid } from "../catalog/repository";
import { assertAdministrator } from "../catalog/admin";
import type { MediaFile } from "../media";
import { signDownload, type DownloadGrant } from "./token";

interface AccessRow {
  id: string;
  user_id: string;
  status: string;
  review: boolean;
}
export async function purchaseAccess(
  user: CurrentUser,
  id: string,
  db: SqlConnection,
  allowAdmin = false,
) {
  if (!isUuid(id)) throw new DeliveryError(404, "Покупка не найдена.");
  const { rows } = await db.query<AccessRow>(
    `SELECT o.id,o.user_id,o.status,EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.needs_review) review FROM orders o
    WHERE o.id=$1 AND (o.user_id=$2 OR ($3::boolean AND EXISTS(SELECT 1 FROM users WHERE id=$2 AND role='ADMIN')))`,
    [id, user.id, allowAdmin],
  );
  if (!rows[0]) throw new DeliveryError(404, "Покупка не найдена.");
  return rows[0];
}
export async function getDeliveryView(
  user: CurrentUser,
  id: string,
  db: Database,
): Promise<DeliveryView> {
  const order = await purchaseAccess(user, id, db);
  const allowed = order.status === "PAID" && !order.review;
  const { rows: files } = await db.query<{
    id: string;
    original_name: string;
    size_bytes: string;
  }>(
    `SELECT f.id,f.original_name,f.size_bytes FROM order_files x JOIN files f ON f.id=x.file_id WHERE x.order_id=$1 AND f.status='READY' ORDER BY f.id`,
    [id],
  );
  const { rows: docs } = await db.query<{
    id: string;
    status: "PENDING" | "READY" | "FAILED";
    original_name: string | null;
  }>(
    `SELECT d.id,d.status,f.original_name FROM documents d LEFT JOIN files f ON f.id=d.file_id WHERE d.order_id=$1`,
    [id],
  );
  return {
    allowed,
    file:
      allowed && files[0]
        ? {
            id: files[0].id,
            name: files[0].original_name,
            size: Number(files[0].size_bytes),
          }
        : null,
    document: docs[0]
      ? { id: docs[0].id, status: docs[0].status, name: docs[0].original_name }
      : null,
  };
}
async function purchaseFile(
  user: CurrentUser,
  id: string,
  db: Database,
  document: boolean,
) {
  const order = await purchaseAccess(user, id, db, document);
  if (
    order.review ||
    !(document
      ? ["PAID", "REFUNDED"].includes(order.status)
      : order.status === "PAID")
  )
    throw new DeliveryError(
      409,
      "Скачивание для этого состояния заказа недоступно.",
    );
  const { rows } = await db.query<MediaFile & { original_name: string }>(
    document
      ? `SELECT f.* FROM documents d JOIN files f ON f.id=d.file_id WHERE d.order_id=$1 AND d.status='READY' AND f.status='READY' AND f.kind='DOCUMENT'`
      : `SELECT f.* FROM order_files x JOIN files f ON f.id=x.file_id WHERE x.order_id=$1 AND f.status='READY' AND f.kind IN ('MP3','PREVIEW','WAV','STEMS','PROJECT','DRUMKIT') ORDER BY f.id`,
    [id],
  );
  if (!rows[0])
    throw new DeliveryError(
      409,
      document
        ? "Документ пока не готов. Повтори подготовку позже."
        : "Файл пока недоступен. Попробуй позже.",
    );
  return rows[0];
}
export async function issuePurchaseDownload(
  user: CurrentUser,
  id: string,
  document: boolean,
  db: Database,
  secret: string,
) {
  const file = await purchaseFile(user, id, db, document);
  return downloadLink(
    {
      user: user.id,
      subject: id,
      file: file.id,
      purpose: document ? "document" : "purchase",
    },
    secret,
  );
}
function downloadLink(grant: Omit<DownloadGrant, "exp">, secret: string) {
  return {
    url: `/api/downloads?token=${signDownload(grant, secret)}`,
    expiresIn: 300,
  };
}

interface FreeRow {
  id: string;
  title: string;
  authors: string[];
  revision: number;
  file_id: string;
  checksum: string;
  terms_id: string;
  version: string;
  body: string;
}
async function freeRow(id: string, db: SqlConnection, lock = false) {
  if (!isUuid(id)) throw new DeliveryError(404, "Бит не найден.");
  const { rows } = await db.query<FreeRow>(
    `SELECT p.id,p.title,p.authors,p.revision,f.id file_id,f.checksum,t.id terms_id,t.version,t.body FROM products p
    JOIN offers o ON o.product_id=p.id AND o.kind='MP3' JOIN files f ON f.id=o.file_id AND f.status='READY' AND f.content_type='audio/mpeg'
    CROSS JOIN LATERAL (SELECT * FROM terms_versions WHERE kind='FREE_MP3' ORDER BY created_at DESC,id DESC LIMIT 1) t
    WHERE p.id=$1 AND p.type='BEAT' AND p.status='PUBLISHED' AND p.exclusive_order_id IS NULL${lock ? " FOR UPDATE OF p" : ""}`,
    [id],
  );
  if (!rows[0])
    throw new DeliveryError(
      404,
      "Бесплатное скачивание этого бита недоступно.",
    );
  return rows[0];
}
export async function getFreeDownload(
  user: CurrentUser,
  id: string,
  db: Database,
): Promise<FreeDownloadView> {
  const row = await freeRow(id, db);
  const { rows } = await db.query(
    "SELECT id FROM free_acceptances WHERE user_id=$1 AND product_id=$2 AND terms_version_id=$3",
    [user.id, id, row.terms_id],
  );
  return {
    productId: id,
    title: row.title,
    authors: row.authors,
    revision: row.revision,
    termsId: row.terms_id,
    terms: row.body,
    accepted: !!rows.length,
  };
}
export async function issueFreeDownload(
  user: CurrentUser,
  id: string,
  input: Record<string, unknown>,
  db: Database,
  secret: string,
) {
  const grant = await db.transaction(async (tx) => {
    const row = await freeRow(id, tx, true);
    if (input.revision !== row.revision || input.termsId !== row.terms_id)
      throw new DeliveryError(
        409,
        "Бит или условия изменились. Обнови страницу перед скачиванием.",
      );
    let { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM free_acceptances WHERE user_id=$1 AND product_id=$2 AND terms_version_id=$3",
      [user.id, id, row.terms_id],
    );
    if (!rows.length) {
      if (input.accepted !== true)
        throw new DeliveryError(
          400,
          "Подтверди ознакомление с условиями бесплатного использования.",
        );
      const snapshot = {
        id: row.id,
        title: row.title,
        authors: row.authors,
        fileId: row.file_id,
        checksum: row.checksum,
        terms: { id: row.terms_id, version: row.version, body: row.body },
        demonstration: true,
      };
      ({ rows } = await tx.query<{ id: string }>(
        `INSERT INTO free_acceptances(user_id,product_id,product_snapshot,terms_version_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,product_id,terms_version_id) DO UPDATE SET accepted_at=free_acceptances.accepted_at RETURNING id`,
        [user.id, id, JSON.stringify(snapshot), row.terms_id],
      ));
    }
    return {
      user: user.id,
      subject: rows[0].id,
      file: row.file_id,
      purpose: "free" as const,
    };
  });
  return downloadLink(grant, secret);
}
export async function resolveDownload(
  user: CurrentUser,
  grant: DownloadGrant,
  db: Database,
) {
  if (grant.purpose !== "free") {
    const file = await purchaseFile(
      user,
      grant.subject,
      db,
      grant.purpose === "document",
    );
    if (file.id !== grant.file) throw new DeliveryError(404, "Файл не найден.");
    return file;
  }
  const { rows } = await db.query<{ product_id: string }>(
    "SELECT product_id FROM free_acceptances WHERE id=$1 AND user_id=$2",
    [grant.subject, user.id],
  );
  if (!rows[0]?.product_id) throw new DeliveryError(404, "Бит не найден.");
  const row = await freeRow(rows[0].product_id, db);
  const { rows: accepted } = await db.query(
    "SELECT id FROM free_acceptances WHERE id=$1 AND terms_version_id=$2",
    [grant.subject, row.terms_id],
  );
  if (row.file_id !== grant.file || !accepted.length)
    throw new DeliveryError(
      404,
      "Файл или условия изменились. Получи новую ссылку.",
    );
  const { rows: files } = await db.query<MediaFile & { original_name: string }>(
    "SELECT * FROM files WHERE id=$1 AND status='READY'",
    [grant.file],
  );
  if (!files[0]) throw new DeliveryError(404, "Файл не найден.");
  return files[0];
}
export async function getAdminDocuments(user: CurrentUser, db: Database) {
  await assertAdministrator(user, db);
  const { rows } = await db.query<{
    id: string;
    title: string;
    buyer: string;
    status: string;
  }>(`SELECT o.id,o.snapshot->'product'->>'title' title,o.snapshot->'buyer'->>'name' buyer,d.status
    FROM orders o JOIN documents d ON d.order_id=o.id WHERE o.status IN ('PAID','REFUNDED') ORDER BY o.paid_at DESC LIMIT 100`);
  return rows;
}
