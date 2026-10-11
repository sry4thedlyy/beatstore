import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import type { Database } from "../db/connection";
import type { PurchaseSnapshot } from "../../domain/checkout";
import { STORAGE_LIMIT } from "../../domain/catalog-editor";
import {
  PDF_RENDERER_VERSION,
  renderLicensePdf,
  type LicenseDocumentInput,
} from "./pdf";
import {
  newFileStorage,
  type YandexStorage,
  type ObjectReference,
} from "../storage/yandex";

const RESERVE = 2 * 1024 * 1024;
export function documentDirectory() {
  return path.resolve(/*turbopackIgnore: true*/ ".data/documents");
}
export interface DocumentOptions {
  directory?: string;
  render?: (input: LicenseDocumentInput) => Promise<Buffer>;
  storage?: YandexStorage | null;
}
export async function ensureLicenseDocument(
  orderId: string,
  db: Database,
  options: DocumentOptions = {},
  retry = false,
) {
  await db.query(
    `INSERT INTO documents(order_id,template_version_id) SELECT o.id,(o.snapshot->'terms'->>'id')::uuid FROM orders o
    WHERE o.id=$1 AND o.status='PAID' AND o.purchase_kind<>'DRUMKIT' AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.needs_review)
    ON CONFLICT(order_id) DO NOTHING`,
    [orderId],
  );
  const lease = randomUUID();
  const { rows } = await db.query<{ id: string; renderer_version: string }>(
    `UPDATE documents d SET lease_token=$2,lease_until=now()+interval '2 minutes',attempted_at=now()
    WHERE d.order_id=$1 AND d.status<>'READY' AND (d.lease_until IS NULL OR d.lease_until<=now())
    AND ($3::boolean OR d.attempted_at IS NULL OR d.attempted_at<=now()-interval '30 seconds')
    AND EXISTS(SELECT 1 FROM orders o WHERE o.id=d.order_id AND o.status='PAID') RETURNING d.id,d.renderer_version`,
    [orderId, lease, retry],
  );
  if (!rows[0]) return;
  const doc = rows[0],
    fileId = randomUUID(),
    key = `${fileId}.pdf`;
  const directory = options.directory ?? documentDirectory(),
    target = path.join(directory, key);
  let reserved = false,
    written = false,
    ready = false;
  let cloud: YandexStorage | null = null,
    ref: ObjectReference | undefined;
  try {
    cloud = options.storage === undefined ? newFileStorage() : options.storage;
    const destination = cloud
      ? cloud.reference("documents", key)
      : { bucket: "local-document", object_key: key };
    ref = destination;
    if (doc.renderer_version !== PDF_RENDERER_VERSION)
      throw new Error("Unavailable renderer version");
    const { rows: orders } = await db.query<{
      snapshot: PurchaseSnapshot;
      paid_at: Date;
    }>("SELECT snapshot,paid_at FROM orders WHERE id=$1", [orderId]);
    const bytes = await (options.render ?? renderLicensePdf)({
      id: doc.id,
      orderId,
      paidAt: orders[0].paid_at,
      snapshot: orders[0].snapshot,
    });
    if (!bytes.length || bytes.length > RESERVE)
      throw new Error("Document too large");
    await db.transaction(async (tx) => {
      await tx.exec("LOCK TABLE files IN SHARE ROW EXCLUSIVE MODE");
      const { rows: active } = await tx.query(
        `SELECT id FROM documents WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND status<>'READY' FOR UPDATE`,
        [doc.id, lease],
      );
      if (!active.length) throw new Error("Generation lease expired");
      const { rows: used } = await tx.query<{ used: string }>(
        "SELECT coalesce(sum(size_bytes),0)::text used FROM files WHERE status IN ('READY','PENDING')",
      );
      if (Number(used[0].used) + bytes.length > STORAGE_LIMIT)
        throw new Error("Storage quota exceeded");
      await tx.query(
        `INSERT INTO files(id,bucket,object_key,original_name,content_type,size_bytes,checksum,kind,status)
        VALUES($1,$6,$2,$3,'application/pdf',$4,$5,'DOCUMENT','PENDING')`,
        [
          fileId,
          destination.object_key,
          `license-${orderId}.pdf`,
          bytes.length,
          createHash("sha256").update(bytes).digest("hex"),
          destination.bucket,
        ],
      );
    });
    reserved = true;
    if (cloud) {
      await cloud.putBytes(
        ref,
        bytes,
        "application/pdf",
        createHash("sha256").update(bytes).digest("hex"),
        lease,
      );
    } else {
      await mkdir(directory, { recursive: true });
      const handle = await open(target, "wx", 0o600);
      written = true;
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    }
    await db.transaction(async (tx) => {
      await tx.exec("LOCK TABLE files IN SHARE ROW EXCLUSIVE MODE");
      const { rows: active } = await tx.query(
        `SELECT d.id FROM documents d JOIN orders o ON o.id=d.order_id WHERE d.id=$1 AND d.lease_token=$2 AND d.lease_until>now() AND d.status<>'READY'
        AND o.status='PAID' AND NOT EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.needs_review) FOR UPDATE OF o,d`,
        [doc.id, lease],
      );
      if (!active.length) throw new Error("Order or lease changed");
      await tx.query("UPDATE files SET status='READY' WHERE id=$1", [fileId]);
      await tx.query(
        "UPDATE documents SET status='READY',file_id=$3,generated_at=now(),last_error=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",
        [doc.id, lease, fileId],
      );
    });
    ready = true;
  } catch {
    if (written && !ready) await unlink(target).catch(() => {});
    const cleaned =
      !cloud ||
      !ref ||
      !reserved ||
      ready ||
      (await cloud.removeOwned(ref, lease));
    if (reserved && !ready && cleaned)
      await db.query("DELETE FROM files WHERE id=$1 AND status='PENDING'", [
        fileId,
      ]);
    await db.query(
      "UPDATE documents SET status='FAILED',last_error='Не удалось подготовить PDF. Повторите попытку позже.',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status<>'READY'",
      [doc.id, lease],
    );
  }
}
