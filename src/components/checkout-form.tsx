"use client";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { formatPrice, offerNames } from "@/domain/pricing";
import type { PaymentProviderName, PurchaseSnapshot } from "@/domain/checkout";
import { readJson, requestFailure } from "./read-json";
const checkoutFailure =
  "Не удалось получить ответ сервера. Проверь заказы в личном кабинете или повтори оформление.";
export function CheckoutForm({
  snapshot,
  revision,
  provider,
}: {
  snapshot: PurchaseSnapshot;
  revision: number;
  provider: PaymentProviderName;
}) {
  const router = useRouter(),
    key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    key.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: snapshot.product.id,
          kind: snapshot.license.kind,
          revision,
          requestKey: key.current,
          accepted: form.get("accepted") === "on",
        }),
      });
      const value = await readJson<{ id: string }>(response, checkoutFailure);
      router.push(`/orders/${value.id}`);
      router.refresh();
    } catch (e) {
      setError(requestFailure(e, checkoutFailure));
      setBusy(false);
    }
  }
  return (
    <form className="checkout-form" onSubmit={submit}>
      <div className="purchase-summary">
        <span>{offerNames[snapshot.license.kind]}</span>
        <strong>{formatPrice(snapshot.price.total)}</strong>
      </div>
      {snapshot.price.total < snapshot.price.base && (
        <p className="checkout-muted">
          Цена без скидки: {formatPrice(snapshot.price.base)}. Скидка:{" "}
          {Number(snapshot.price.discount)}%.
        </p>
      )}
      <p className="checkout-muted">
        Покупатель: {snapshot.buyer.name} · {snapshot.buyer.email}
      </p>
      <div className="demo-notice">
        {provider === "DEMO"
          ? "Локальная демонстрация оплаты. Банковская карта не нужна, деньги не списываются."
          : "Тестовый магазин ЮKassa. Используй только тестовую карту из документации сервиса."}
      </div>
      <label className="checkout-accept">
        <input type="checkbox" name="accepted" required disabled={busy} />
        <span>
          Я ознакомился с демонстрационными условиями этой покупки. Это тестовый
          заказ без реальной передачи прав.
        </span>
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary-button" disabled={busy}>
        {busy ? "Создаём заказ…" : "Создать тестовый заказ"}
      </button>
    </form>
  );
}
