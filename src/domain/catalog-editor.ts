import { calculatePrice } from "./pricing";

export type ProductType = "BEAT" | "DRUMKIT";
export type ProductStatus =
  "DRAFT" | "PUBLISHED" | "UNPUBLISHED" | "EXCLUSIVE_SOLD";
export type UploadKind =
  "COVER" | "MP3" | "WAV" | "STEMS" | "PROJECT" | "PREVIEW" | "DRUMKIT";
export const statusNames: Record<ProductStatus, string> = {
  DRAFT: "Черновик",
  PUBLISHED: "Опубликован",
  UNPUBLISHED: "Снят с публикации",
  EXCLUSIVE_SOLD: "Эксклюзив продан",
};
export const uploadNames: Record<UploadKind, string> = {
  COVER: "Обложка",
  MP3: "Полный MP3",
  WAV: "Полный WAV",
  STEMS: "Дорожки WAV в ZIP",
  PROJECT: "Проект FL Studio в ZIP",
  PREVIEW: "MP3-превью",
  DRUMKIT: "Архив драмкита",
};
export const uploadKinds = (type: ProductType): UploadKind[] =>
  type === "BEAT"
    ? ["COVER", "MP3", "WAV", "STEMS", "PROJECT"]
    : ["COVER", "PREVIEW", "DRUMKIT"];
export const STORAGE_LIMIT = 1024 * 1024 * 1024;
export const uploadLimits: Record<UploadKind, number> = {
  COVER: 10 * 1024 * 1024,
  MP3: 50 * 1024 * 1024,
  PREVIEW: 50 * 1024 * 1024,
  WAV: 250 * 1024 * 1024,
  STEMS: 500 * 1024 * 1024,
  PROJECT: 500 * 1024 * 1024,
  DRUMKIT: 500 * 1024 * 1024,
};
export const extensions: Record<UploadKind, string> = {
  COVER: ".jpg,.jpeg,.png,.webp",
  MP3: ".mp3",
  PREVIEW: ".mp3",
  WAV: ".wav",
  STEMS: ".zip",
  PROJECT: ".zip",
  DRUMKIT: ".zip",
};
export const kitRestriction =
  "Перепродажа и распространение архива драмкита запрещены.";

export class CatalogError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}
export interface ProductInput {
  title: string;
  description: string;
  discount: string;
  authors: string[];
  bpm: number | null;
  musicalKey: string | null;
  royalty: string | null;
  projectRequirements: string | null;
  price: number | null;
  usageRules: string;
}
function text(
  value: unknown,
  label: string,
  max: number,
  required = false,
): string {
  if (typeof value !== "string")
    throw new CatalogError(400, `Проверь поле «${label}».`);
  const result = value.trim();
  if (result.length > max || (required && !result))
    throw new CatalogError(
      400,
      `Поле «${label}»: ${required ? "от 1 до" : "до"} ${max} символов.`,
    );
  return result;
}
export function decimal(value: unknown, label: string, maximum = 100): string {
  const normalized =
    typeof value === "string" ? value.trim().replace(",", ".") : "";
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(normalized))
    throw new CatalogError(
      400,
      `${label}: укажи число с точностью до двух знаков.`,
    );
  const [whole, fraction = ""] = normalized.split(".");
  const points = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (points > maximum * 100)
    throw new CatalogError(
      400,
      `${label}: значение должно быть от 0 до ${maximum}.`,
    );
  return `${Math.floor(points / 100)}.${String(points % 100).padStart(2, "0")}`;
}
export function rubles(value: unknown): number | null {
  if (value === "") return null;
  const normalized =
    typeof value === "string" ? value.trim().replace(",", ".") : "";
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(normalized))
    throw new CatalogError(
      400,
      "Цена: укажи сумму в рублях с точностью до копейки.",
    );
  const [whole, fraction = ""] = normalized.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (result <= 0 || result > 2147483647)
    throw new CatalogError(
      400,
      "Цена должна быть больше нуля и не превышать 21 474 836,47 ₽.",
    );
  return result;
}
export function parseProductInput(
  body: Record<string, unknown>,
  type: ProductType,
): ProductInput {
  const discount = decimal(body.discount, "Скидка", 99.99);
  const price = rubles(body.price);
  if (price)
    calculatePrice(price, discount, type === "BEAT" ? "EXCLUSIVE" : "DRUMKIT");
  let authors: string[] = [],
    bpm: number | null = null;
  if (type === "BEAT") {
    if (!Array.isArray(body.authors) || body.authors.length > 20)
      throw new CatalogError(400, "Укажи не более 20 авторов.");
    authors = body.authors.map((value) => text(value, "Автор", 80, true));
    if (body.bpm !== "") {
      if (
        typeof body.bpm !== "string" ||
        !/^\d{1,3}$/.test(body.bpm) ||
        Number(body.bpm) < 1
      )
        throw new CatalogError(400, "BPM: целое число от 1 до 999.");
      bpm = Number(body.bpm);
    }
  }
  return {
    title: text(body.title, "Название", 160, true),
    description: text(body.description, "Описание", 10000),
    discount,
    price,
    authors,
    bpm,
    musicalKey:
      type === "BEAT" ? text(body.musicalKey, "Тональность", 80) || null : null,
    royalty: type === "BEAT" ? decimal(body.royalty, "Роялти") : null,
    projectRequirements:
      type === "BEAT"
        ? text(body.projectRequirements, "Требования к проекту", 5000) || null
        : null,
    usageRules:
      type === "DRUMKIT"
        ? text(body.usageRules, "Правила использования звуков", 10000)
        : "",
  };
}
export function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new CatalogError(400, "Не указана версия карточки. Обнови страницу.");
  return value as number;
}
export interface EditorFile {
  id: string;
  name: string;
  size: number;
}
export interface EditorProduct extends ProductInput {
  id: string;
  type: ProductType;
  status: ProductStatus;
  revision: number;
  duration: number | null;
  files: Partial<Record<UploadKind, EditorFile>>;
  thumbnailId: string | null;
  hasPurchases: boolean;
  locked: boolean;
  missing: string[];
}
export function publicationIssues(
  product: Omit<EditorProduct, "missing">,
): string[] {
  const missing: string[] = [];
  for (const kind of uploadKinds(product.type))
    if (!product.files[kind]) missing.push(uploadNames[kind]);
  if (!product.thumbnailId && product.files.COVER)
    missing.push("Миниатюра обложки");
  if (!product.duration) missing.push("Длительность аудио");
  if (product.type === "BEAT") {
    if (!product.authors.length) missing.push("Авторы");
    if (!product.bpm) missing.push("BPM");
    if (!product.musicalKey) missing.push("Тональность");
    if (product.royalty === null) missing.push("Роялти");
    if (!product.projectRequirements) missing.push("Требования к проекту");
  } else if (!product.usageRules) missing.push("Правила использования звуков");
  if (!product.price)
    missing.push(product.type === "BEAT" ? "Цена эксклюзива" : "Цена драмкита");
  return missing;
}
