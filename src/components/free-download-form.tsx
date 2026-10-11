"use client";
import { useState } from "react";
import type { FreeDownloadView } from "@/domain/delivery";
import { DownloadButton } from "./download-button";
export function FreeDownloadForm({ quote }: { quote: FreeDownloadView }) {
  const [accepted, setAccepted] = useState(quote.accepted);
  return (
    <section className="checkout-panel">
      <h2>Бесплатный MP3</h2>
      <p>{quote.terms}</p>
      <p>Авторы: {quote.authors.join(", ")}</p>
      <div className="demo-notice">
        Демонстрационный бит для проверки скачивания и сохранения условий.
      </div>
      {quote.accepted ? (
        <p className="checkout-muted">
          Условия этой версии уже приняты. Повторное подтверждение не требуется.
        </p>
      ) : (
        <label className="terms-checkbox">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span>
            Я ознакомился с демонстрационными условиями бесплатного
            использования MP3.
          </span>
        </label>
      )}
      {accepted ? (
        <DownloadButton
          url={`/api/products/${quote.productId}/free-download`}
          body={{ accepted, revision: quote.revision, termsId: quote.termsId }}
          label="Скачать бесплатный MP3"
        />
      ) : (
        <button className="secondary-button" disabled>
          Скачать бесплатный MP3
        </button>
      )}
    </section>
  );
}
