import type { PurchaseSnapshot } from "@/domain/checkout";
import { offerNames } from "@/domain/pricing";
export function PurchaseConditions({
  snapshot,
}: {
  snapshot: PurchaseSnapshot;
}) {
  const { product, license } = snapshot;
  return (
    <section className="checkout-panel">
      <h2>Условия покупки</h2>
      <p>
        <strong>{offerNames[license.kind]}</strong> ·{" "}
        {snapshot.file.kind === "PROJECT"
          ? "ZIP проекта FL Studio"
          : snapshot.file.kind === "STEMS"
            ? "ZIP дорожек WAV"
            : snapshot.file.kind === "DRUMKIT"
              ? "ZIP драмкита"
              : snapshot.file.kind === "WAV"
                ? "Полный бит в формате WAV"
                : "Полный бит в формате MP3"}
      </p>
      {!!product.authors.length && <p>Авторы: {product.authors.join(", ")}</p>}
      {license.tracks && (
        <ul className="license-facts">
          <li>Один трек, название не требуется</li>
          <li>500 000 прослушиваний на каждой площадке</li>
          <li>
            Ранее купленная лицензия сохраняется после продажи эксклюзива до
            превышения лимита
          </li>
        </ul>
      )}
      {license.kind === "EXCLUSIVE" && (
        <>
          <p className="royalty-note">
            Роялти: {Number(product.royalty)}% · {license.royaltyBasis}.{" "}
            {license.reporting}.
          </p>
          <p>{product.projectRequirements}</p>
        </>
      )}
      <details className="terms-details">
        <summary>Полные демонстрационные условия</summary>
        <p>{snapshot.terms.body}</p>
      </details>
    </section>
  );
}
