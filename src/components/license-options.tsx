"use client";

import { useState } from "react";
import {
  calculatePrice,
  formatPrice,
  offerNames,
  type OfferKind,
} from "@/domain/pricing";

interface Option {
  id: string;
  kind: OfferKind;
  basePrice: number;
  terms: string;
}
const descriptions: Record<OfferKind, string> = {
  MP3: "Полный бит в MP3 для коммерческого использования в одном треке.",
  WAV: "Один цельный WAV-файл бита. MP3 в комплект не входит.",
  STEMS:
    "ZIP-архив с отдельными дорожками в WAV. Цельный WAV и MP3 в комплект не входят.",
  EXCLUSIVE:
    "Исключительные права и ZIP-архив проекта FL Studio. Ранее выданные платные лицензии продолжают действовать до превышения лимита.",
  DRUMKIT: "ZIP-архив со звуками и файлом правил использования.",
};

export function LicenseOptions({
  offers,
  discount,
  royalty,
}: {
  offers: Option[];
  discount: string;
  royalty: string | null;
}) {
  const [selected, setSelected] = useState(offers[0]?.id);
  const active = offers.find((offer) => offer.id === selected) ?? offers[0];
  if (!active) return null;
  return (
    <section className="license-panel" aria-label="Варианты покупки и условия">
      <h2>
        {active.kind === "DRUMKIT" ? "Что входит в набор" : "Выбери лицензию"}
      </h2>
      <div className="offer-list" role="group" aria-label="Вариант лицензии">
        {offers.map((offer) => {
          const price = calculatePrice(offer.basePrice, discount, offer.kind);
          return (
            <button
              type="button"
              key={offer.id}
              className={`offer ${active.id === offer.id ? "selected" : ""}`}
              onClick={() => setSelected(offer.id)}
              aria-pressed={active.id === offer.id}
            >
              <span className="offer-name">
                <span className="selection-dot" />
                {offerNames[offer.kind]}
              </span>
              <span className="offer-price">
                {price < offer.basePrice && (
                  <del>{formatPrice(offer.basePrice)}</del>
                )}
                {formatPrice(price)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="offer-description" aria-live="polite">
        <h3>{offerNames[active.kind]}</h3>
        <p>{descriptions[active.kind]}</p>
        {active.kind === "EXCLUSIVE" && (
          <p className="royalty-note">
            Роялти автору: {Number(royalty)}% от дохода со стриминга после
            комиссий. Отчёт и выплата — каждый календарный квартал, в течение 15
            дней после его окончания.
          </p>
        )}
        {!["EXCLUSIVE", "DRUMKIT"].includes(active.kind) && (
          <ul className="license-facts">
            <li>Один трек</li>
            <li>500 000 прослушиваний на каждой площадке</li>
            <li>Коммерческое использование</li>
          </ul>
        )}
        <details className="terms-details">
          <summary>Полные условия</summary>
          <p>{active.terms}</p>
        </details>
      </div>
    </section>
  );
}
