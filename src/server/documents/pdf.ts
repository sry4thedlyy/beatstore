import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PurchaseSnapshot } from "../../domain/checkout";
import { offerNames, formatPrice } from "../../domain/pricing";

export const PDF_RENDERER_VERSION = "license-pdf-v1";
export interface LicenseDocumentInput {
  id: string;
  orderId: string;
  paidAt: Date;
  snapshot: PurchaseSnapshot;
}
let fonts: Promise<Buffer[]> | undefined;
function fontBytes() {
  fonts ??= Promise.all(
    ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"].map((name) =>
      readFile(path.resolve(/*turbopackIgnore: true*/ "assets/fonts", name)),
    ),
  );
  return fonts;
}
export async function renderLicensePdf(input: LicenseDocumentInput) {
  const s = input.snapshot;
  if (s.demonstration !== true || s.license.kind === "DRUMKIT")
    throw new Error("Only demonstration beat licenses have PDF documents");
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await fontBytes();
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  pdf.setTitle(`Демонстрационная лицензия ${offerNames[s.license.kind]}`);
  pdf.setAuthor("Beatstore · демонстрационный магазин");
  pdf.setCreator("Beatstore");
  pdf.setCreationDate(input.paidAt);
  pdf.setModificationDate(input.paidAt);
  const ink = rgb(0.12, 0.14, 0.19),
    blue = rgb(0.22, 0.32, 0.82);
  const width = 499,
    bottom = 60;
  let page: PDFPage, y: number;
  function nextPage() {
    page = pdf.addPage([595, 842]);
    page.drawText("BEATSTORE", {
      x: 48,
      y: 797,
      size: 12,
      font: bold,
      color: blue,
    });
    page.drawText("ДЕМОНСТРАЦИОННЫЙ ДОКУМЕНТ", {
      x: 48,
      y: 775,
      size: 9,
      font: bold,
      color: ink,
    });
    page.drawLine({
      start: { x: 48, y: 761 },
      end: { x: 547, y: 761 },
      thickness: 1,
      color: rgb(0.84, 0.86, 0.91),
    });
    y = 736;
  }
  function clean(text: string, font: PDFFont) {
    const supported = new Set(font.getCharacterSet());
    return Array.from(String(text).normalize("NFC"))
      .map((c) =>
        (c.codePointAt(0)! < 32 && c !== "\n") || c.codePointAt(0) === 127
          ? " "
          : c === "\n" || supported.has(c.codePointAt(0)!)
            ? c
            : `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`,
      )
      .join("");
  }
  function lines(text: string, font: PDFFont, size: number) {
    const result: string[] = [];
    for (const paragraph of clean(text, font).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (line && font.widthOfTextAtSize(`${line} ${word}`, size) > width) {
          result.push(line);
          line = "";
        }
        if (font.widthOfTextAtSize(word, size) > width) {
          if (line) {
            result.push(line);
            line = "";
          }
          for (const char of Array.from(word)) {
            if (font.widthOfTextAtSize(line + char, size) > width) {
              result.push(line);
              line = "";
            }
            line += char;
          }
        } else line += (line ? " " : "") + word;
      }
      result.push(line);
    }
    return result;
  }
  function text(value: string, size = 10, font = regular, gap = 9) {
    const height = size * 1.5;
    for (const line of lines(value, font, size)) {
      if (y - height < bottom) nextPage();
      page.drawText(line, { x: 48, y, size, font, color: ink });
      y -= height;
    }
    y -= gap;
  }
  function section(label: string) {
    if (y < bottom + 65) nextPage();
    y -= 5;
    text(label, 12, bold, 8);
  }
  nextPage();
  text(
    s.license.kind === "EXCLUSIVE"
      ? "Приобретение эксклюзивных прав"
      : `Лицензия ${offerNames[s.license.kind]}`,
    20,
    bold,
    12,
  );
  text(
    "Образец для проверки работы магазина. Реальные деньги не списываются; этот документ не передаёт права и не заменяет договор для настоящей продажи.",
    10,
    regular,
    15,
  );
  text(`Заказ: ${input.orderId}`, 9);
  text(
    `Дата тестовой покупки: ${input.paidAt.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", hour12: false })} МСК`,
    9,
  );
  section("Стороны и предмет покупки");
  text(`Продавец (тестовые данные): ${s.seller.name}, ${s.seller.email}`);
  text(
    `Покупатель демонстрационного заказа: ${s.buyer.name}, ${s.buyer.email}`,
  );
  text(`Бит: ${s.product.title}`, 12, bold);
  text(`Авторы: ${s.product.authors.join(", ")}`);
  text(
    `Вариант: ${offerNames[s.license.kind]}. Стоимость: ${formatPrice(s.price.total)}.`,
  );
  text(`Выдаваемый файл: ${s.file.name}`);
  section("Приобретённые условия");
  if (s.license.kind === "EXCLUSIVE") {
    text(
      `Роялти первоначальному автору: ${s.product.royalty}%. База расчёта: ${s.license.royaltyBasis}.`,
    );
    text(`Отчётность и выплаты: ${s.license.reporting}.`);
    text(
      "Покупатель сохраняет авторство первоначальных авторов и ранее выданные платные лицензии до превышения ими лимита.",
    );
    text(`Требования к проекту: ${s.product.projectRequirements}`);
  } else {
    text(
      `Разрешён один трек с битом. Лимит: ${s.license.streamLimitPerPlatform?.toLocaleString("ru-RU")} прослушиваний на каждой площадке отдельно.`,
    );
    text(
      "Лицензия бессрочная до превышения лимита хотя бы на одной площадке. Разрешены музыкальные площадки и радиостанции. Указание всех авторов обязательно.",
    );
    text(
      "Ранее купленная платная лицензия сохраняется после продажи эксклюзива до превышения лимита. Магазин не отслеживает прослушивания автоматически.",
    );
  }
  section(`Полный текст условий · версия ${s.terms.version}`);
  text(s.terms.body);
  for (const [i, p] of pdf.getPages().entries()) {
    p.drawLine({
      start: { x: 48, y: 43 },
      end: { x: 547, y: 43 },
      thickness: 0.7,
      color: rgb(0.84, 0.86, 0.91),
    });
    p.drawText(
      `Демонстрация · ${offerNames[s.license.kind]} · ${i + 1} / ${pdf.getPageCount()}`,
      { x: 48, y: 27, font: regular, size: 8, color: ink },
    );
  }
  return Buffer.from(await pdf.save());
}
