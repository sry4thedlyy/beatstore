import "server-only";
import { randomUUID } from "node:crypto";
import {
  CatalogError,
  expectedRevision,
  kitRestriction,
  parseProductInput,
  publicationIssues,
  type EditorProduct,
  type ProductStatus,
  type ProductType,
  type UploadKind,
} from "../../domain/catalog-editor";
import { calculatePrice } from "../../domain/pricing";
import {
  getDatabase,
  type Database,
  type SqlConnection,
} from "../db/connection";
import type { CurrentUser } from "../auth/session";
import { isUuid, type Product } from "./repository";

export async function assertAdministrator(
  user: CurrentUser,
  db: SqlConnection,
) {
  const { rows } = await db.query<{ role: string }>(
    "SELECT role FROM users WHERE id = $1",
    [user.id],
  );
  if (rows[0]?.role !== "ADMIN")
    throw new CatalogError(403, "Доступ разрешён только администратору.");
}
interface Row {
  id: string;
  type: ProductType;
  title: string;
  description: string;
  status: ProductStatus;
  revision: number;
  discount_percent: string;
  authors: string[] | null;
  bpm: number | null;
  musical_key: string | null;
  royalty_percent: string | null;
  project_requirements: string | null;
  duration_seconds: number | null;
  cover_file_id: string | null;
  thumbnail_file_id: string | null;
  preview_file_id: string | null;
  reserved_order_id: string | null;
  has_purchases: boolean;
  awaiting: boolean;
  exclusive_sold: boolean;
}
const rowQuery = `SELECT p.*,
  EXISTS (SELECT 1 FROM orders o WHERE o.product_id=p.id AND o.paid_at IS NOT NULL) AS has_purchases,
  EXISTS (SELECT 1 FROM orders o WHERE o.product_id=p.id AND (o.status='AWAITING_PAYMENT' OR EXISTS (SELECT 1 FROM payments a WHERE a.order_id=o.id AND a.needs_review))) AS awaiting,
  EXISTS (SELECT 1 FROM orders o WHERE o.product_id=p.id AND o.purchase_kind='EXCLUSIVE' AND o.paid_at IS NOT NULL) AS exclusive_sold
  FROM products p WHERE p.id=$1`;
interface OfferRow {
  id: string;
  kind: string;
  base_price_kopecks: number | null;
  file_id: string | null;
  body: string | null;
  parameters: { usageRules?: string } | null;
}
interface FileRow {
  id: string;
  kind: string;
  original_name: string;
  size_bytes: string;
}
async function loadRow(
  db: SqlConnection,
  id: string,
  lock = false,
): Promise<Row> {
  if (!isUuid(id)) throw new CatalogError(404, "Товар не найден.");
  const { rows } = await db.query<Row>(
    rowQuery + (lock ? " FOR UPDATE OF p" : ""),
    [id],
  );
  if (!rows[0]) throw new CatalogError(404, "Товар не найден.");
  return rows[0];
}
function locked(row: Row): boolean {
  return (
    row.status === "EXCLUSIVE_SOLD" ||
    row.exclusive_sold ||
    row.awaiting ||
    !!row.reserved_order_id
  );
}
export async function lockEditableProduct(
  db: SqlConnection,
  id: string,
  revision: number,
): Promise<Row> {
  const row = await loadRow(db, id, true);
  if (locked(row))
    throw new CatalogError(
      409,
      "Изменения недоступны: есть незавершённая оплата, резерв или проданный эксклюзив.",
    );
  if (row.revision !== expectedRevision(revision))
    throw new CatalogError(
      409,
      "Карточка уже изменилась. Обнови страницу перед сохранением.",
    );
  return row;
}
async function loadEditor(db: SqlConnection, row: Row): Promise<EditorProduct> {
  const { rows: offers } = await db.query<OfferRow>(
    `SELECT o.id,o.kind,o.base_price_kopecks,o.file_id,t.body,t.parameters
    FROM offers o LEFT JOIN terms_versions t ON t.id=o.terms_version_id WHERE o.product_id=$1`,
    [row.id],
  );
  const ids = [
    row.cover_file_id,
    row.thumbnail_file_id,
    row.preview_file_id,
    ...offers.map((o) => o.file_id),
  ].filter((id): id is string => !!id);
  const { rows: files } = await db.query<FileRow>(
    `SELECT id,kind,original_name,size_bytes FROM files WHERE id=ANY($1::uuid[]) AND status='READY'`,
    [ids],
  );
  const fileMap = new Map(
    files.map((f) => [
      f.id,
      { id: f.id, name: f.original_name, size: Number(f.size_bytes) },
    ]),
  );
  const attached: EditorProduct["files"] = {};
  if (row.cover_file_id && fileMap.has(row.cover_file_id))
    attached.COVER = fileMap.get(row.cover_file_id);
  if (
    row.type === "DRUMKIT" &&
    row.preview_file_id &&
    fileMap.has(row.preview_file_id)
  )
    attached.PREVIEW = fileMap.get(row.preview_file_id);
  const kinds: Record<string, UploadKind> = {
    MP3: "MP3",
    WAV: "WAV",
    STEMS: "STEMS",
    EXCLUSIVE: "PROJECT",
    DRUMKIT: "DRUMKIT",
  };
  for (const offer of offers)
    if (offer.file_id && fileMap.has(offer.file_id))
      attached[kinds[offer.kind]] = fileMap.get(offer.file_id);
  const priced = offers.find(
    (o) => o.kind === (row.type === "BEAT" ? "EXCLUSIVE" : "DRUMKIT"),
  );
  const product = {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    status: row.status,
    revision: row.revision,
    discount: row.discount_percent,
    authors: row.authors ?? [],
    bpm: row.bpm,
    musicalKey: row.musical_key,
    royalty: row.royalty_percent,
    projectRequirements: row.project_requirements,
    price: priced?.base_price_kopecks ?? null,
    usageRules:
      row.type === "DRUMKIT"
        ? (priced?.parameters?.usageRules ?? priced?.body ?? "")
        : "",
    duration: row.duration_seconds,
    files: attached,
    thumbnailId: row.thumbnail_file_id,
    hasPurchases: row.has_purchases,
    locked: locked(row),
  };
  return { ...product, missing: publicationIssues(product) };
}
export async function getEditorProduct(
  user: CurrentUser,
  id: string,
  connection?: Database,
): Promise<EditorProduct> {
  const db = connection ?? (await getDatabase());
  await assertAdministrator(user, db);
  return loadEditor(db, await loadRow(db, id));
}
export async function getAdminCatalog(
  user: CurrentUser,
  connection?: Database,
) {
  const db = connection ?? (await getDatabase());
  await assertAdministrator(user, db);
  const { rows } = await db.query<{
    id: string;
    title: string;
    type: ProductType;
    status: ProductStatus;
  }>(`SELECT id,title,type,status FROM products ORDER BY created_at DESC,id`);
  const { rows: space } = await db.query<{ used: string }>(
    `SELECT coalesce(sum(size_bytes),0)::text AS used FROM files WHERE status IN ('PENDING','READY')`,
  );
  return { products: rows, usedBytes: Number(space[0].used) };
}
export async function createProduct(
  user: CurrentUser,
  body: Record<string, unknown>,
  connection?: Database,
) {
  const db = connection ?? (await getDatabase());
  const type = body.type;
  if (type !== "BEAT" && type !== "DRUMKIT")
    throw new CatalogError(400, "Выбери бит или драмкит.");
  const input = parseProductInput(
    {
      title: body.title,
      description: "",
      discount: "0",
      price: "",
      authors: [],
      bpm: "",
      musicalKey: "",
      royalty: "0",
      projectRequirements: "",
      usageRules: "",
    },
    type,
  );
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await assertAdministrator(user, tx);
    await tx.query(
      `INSERT INTO products (id,type,title,royalty_percent) VALUES ($1,$2,$3,$4)`,
      [id, type, input.title, input.royalty],
    );
    for (const [kind, price] of type === "BEAT"
      ? [
          ["MP3", 100000],
          ["WAV", 200000],
          ["STEMS", 300000],
          ["EXCLUSIVE", null],
        ]
      : [["DRUMKIT", null]]) {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM terms_versions WHERE kind=$1 AND version='demo-v1'`,
        [kind],
      );
      if (!rows[0])
        throw new CatalogError(
          503,
          "Не найдены шаблоны условий. Выполни подготовку базы.",
        );
      await tx.query(
        `INSERT INTO offers (product_id,kind,base_price_kopecks,terms_version_id) VALUES ($1,$2,$3,$4)`,
        [id, kind, price, rows[0].id],
      );
    }
  });
  return getEditorProduct(user, id, db);
}
export async function saveProduct(
  user: CurrentUser,
  id: string,
  body: Record<string, unknown>,
  connection?: Database,
) {
  const db = connection ?? (await getDatabase());
  const revision = expectedRevision(body.revision);
  const action = body.action;
  if (!["save", "publish", "unpublish"].includes(String(action)))
    throw new CatalogError(400, "Неизвестное действие.");
  await db.transaction(async (tx) => {
    await assertAdministrator(user, tx);
    const row = await lockEditableProduct(tx, id, revision);
    const input = parseProductInput(body, row.type);
    const status =
      action === "publish"
        ? "PUBLISHED"
        : action === "unpublish"
          ? "UNPUBLISHED"
          : row.status;
    const current = await loadEditor(tx, row);
    const next = { ...current, ...input, status };
    if (status === "PUBLISHED") {
      const missing = publicationIssues(next);
      if (missing.length)
        throw new CatalogError(
          400,
          `Для публикации заполни: ${missing.join(", ")}.`,
        );
    }
    await tx.query(
      `UPDATE products SET title=$2,description=$3,discount_percent=$4,authors=$5,bpm=$6,musical_key=$7,
      royalty_percent=$8,project_requirements=$9,status=$10,revision=revision+1,updated_at=now() WHERE id=$1`,
      [
        id,
        input.title,
        input.description,
        input.discount,
        row.type === "BEAT" ? input.authors : null,
        input.bpm,
        input.musicalKey,
        input.royalty,
        input.projectRequirements,
        status,
      ],
    );
    let terms: string | null = null;
    if (row.type === "DRUMKIT" && input.usageRules !== current.usageRules) {
      terms = randomUUID();
      await tx.query(
        `INSERT INTO terms_versions (id,kind,version,body,parameters) VALUES ($1,'DRUMKIT',$2,$3,$4)`,
        [
          terms,
          `product-${id}-${randomUUID()}`,
          `${kitRestriction}\n\n${input.usageRules}`,
          JSON.stringify({ usageRules: input.usageRules }),
        ],
      );
    }
    await tx.query(
      `UPDATE offers SET base_price_kopecks=$2,terms_version_id=coalesce($3,terms_version_id) WHERE product_id=$1 AND kind=$4`,
      [id, input.price, terms, row.type === "BEAT" ? "EXCLUSIVE" : "DRUMKIT"],
    );
  });
  return getEditorProduct(user, id, db);
}
export async function deleteProduct(
  user: CurrentUser,
  id: string,
  body: Record<string, unknown>,
  connection?: Database,
) {
  const db = connection ?? (await getDatabase());
  await db.transaction(async (tx) => {
    await assertAdministrator(user, tx);
    const row = await lockEditableProduct(
      tx,
      id,
      expectedRevision(body.revision),
    );
    if (body.confirmation !== row.title)
      throw new CatalogError(400, "Для удаления введи точное название товара.");
    if (row.has_purchases)
      throw new CatalogError(
        409,
        "Товар с покупками можно только снять с публикации.",
      );
    await tx.query(
      `UPDATE free_acceptances SET product_id=NULL WHERE product_id=$1`,
      [id],
    );
    await tx.query(
      `UPDATE orders SET product_id=NULL,offer_id=NULL WHERE product_id=$1 AND status='CANCELLED' AND paid_at IS NULL`,
      [id],
    );
    await tx.query(`DELETE FROM offers WHERE product_id=$1`, [id]);
    await tx.query(`DELETE FROM products WHERE id=$1`, [id]);
  });
}
export async function getAdminProductView(
  user: CurrentUser,
  id: string,
  connection?: Database,
): Promise<Product> {
  const db = connection ?? (await getDatabase());
  await assertAdministrator(user, db);
  const row = await loadRow(db, id);
  const item = await loadEditor(db, row);
  const { rows: offers } = await db.query<OfferRow>(
    `SELECT o.id,o.kind,o.base_price_kopecks,t.body FROM offers o JOIN terms_versions t ON t.id=o.terms_version_id WHERE o.product_id=$1 ORDER BY o.base_price_kopecks,o.kind`,
    [id],
  );
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    description: item.description,
    discount: item.discount,
    coverId: item.files.COVER?.id ?? "",
    thumbnailId: item.thumbnailId ?? "",
    previewId: item.files[item.type === "BEAT" ? "MP3" : "PREVIEW"]?.id ?? "",
    duration: item.duration ?? 0,
    authors: item.authors,
    bpm: item.bpm,
    musicalKey: item.musicalKey,
    royalty: item.royalty,
    projectRequirements: item.projectRequirements,
    mediaBase: "/api/admin/media",
    reserved: !!row.reserved_order_id,
    offers: offers
      .filter((o) => o.base_price_kopecks)
      .map((o) => ({
        id: o.id,
        kind: o.kind as Product["offers"][number]["kind"],
        basePrice: o.base_price_kopecks!,
        price: calculatePrice(
          o.base_price_kopecks!,
          item.discount,
          o.kind as Product["offers"][number]["kind"],
        ),
        terms: o.body ?? "",
      })),
  };
}
