import "server-only";
import { getDatabase, type Database } from "../db/connection";
import { calculatePrice, type OfferKind } from "../../domain/pricing";

export interface Product {
  id: string;
  type: "BEAT" | "DRUMKIT";
  title: string;
  description: string;
  coverId: string;
  thumbnailId: string;
  previewId: string;
  duration: number;
  authors: string[];
  bpm: number | null;
  musicalKey: string | null;
  royalty: string | null;
  projectRequirements: string | null;
  discount: string;
  offers: Offer[];
  mediaBase?: string;
  reserved?: boolean;
}

export interface Offer {
  id: string;
  kind: OfferKind;
  basePrice: number;
  price: number;
  terms: string;
}

interface ProductRow {
  id: string;
  type: Product["type"];
  title: string;
  description: string;
  cover_file_id: string;
  thumbnail_file_id: string;
  preview_file_id: string;
  duration_seconds: number;
  authors: string[] | null;
  bpm: number | null;
  musical_key: string | null;
  royalty_percent: string | null;
  project_requirements: string | null;
  discount_percent: string;
  reserved_order_id: string | null;
}
interface OfferRow {
  id: string;
  product_id: string;
  kind: OfferKind;
  base_price_kopecks: number;
  body: string;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function getProducts(
  search = "",
  id?: string,
  connection?: Database,
): Promise<Product[]> {
  if (id && !isUuid(id)) return [];
  const db = connection ?? (await getDatabase());
  // Escape LIKE wildcards: search text is literal, and all user input is parameterized.
  const query = search
    .trim()
    .slice(0, 120)
    .replace(/[\\%_]/g, "\\$&");
  const { rows } = await db.query<ProductRow>(
    `SELECT id, type, title, description, cover_file_id, thumbnail_file_id,
    preview_file_id, duration_seconds, authors, bpm, musical_key, royalty_percent, project_requirements, discount_percent, reserved_order_id
    FROM products WHERE status = 'PUBLISHED' AND title ILIKE $1 ESCAPE '\\' ${id ? "AND id = $2" : ""}
    ORDER BY created_at, id`,
    id ? [`%${query}%`, id] : [`%${query}%`],
  );
  if (!rows.length) return [];
  const { rows: offers } = await db.query<OfferRow>(
    `SELECT o.id, o.product_id, o.kind, o.base_price_kopecks, t.body
    FROM offers o JOIN terms_versions t ON t.id = o.terms_version_id
    WHERE o.product_id = ANY($1::uuid[]) ORDER BY o.base_price_kopecks, o.kind`,
    [rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    coverId: row.cover_file_id,
    thumbnailId: row.thumbnail_file_id,
    previewId: row.preview_file_id,
    duration: row.duration_seconds,
    authors: row.authors ?? [],
    bpm: row.bpm,
    musicalKey: row.musical_key,
    royalty: row.royalty_percent,
    projectRequirements: row.project_requirements,
    discount: row.discount_percent,
    reserved: !!row.reserved_order_id,
    offers: offers
      .filter((offer) => offer.product_id === row.id)
      .map((offer) => ({
        id: offer.id,
        kind: offer.kind,
        basePrice: offer.base_price_kopecks,
        price: calculatePrice(
          offer.base_price_kopecks,
          row.discount_percent,
          offer.kind,
        ),
        terms: offer.body,
      })),
  }));
}
