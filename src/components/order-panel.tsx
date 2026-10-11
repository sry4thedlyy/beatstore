"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { orderStatusNames, type OrderView } from "@/domain/checkout";
import { formatPrice } from "@/domain/pricing";
import { DeliveryPanel } from "./delivery-panel";
import type { DeliveryView } from "@/domain/delivery";
import { readJson, requestFailure } from "./read-json";
const paymentFailure =
  "Не удалось проверить оплату. Заказ сохранён; обнови страницу или попробуй позже.";
export function OrderPanel({
  initial,
  delivery,
}: {
  initial: OrderView;
  delivery: DeliveryView;
}) {
  const [order, setOrder] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const router = useRouter(),
    inFlight = useRef(false);
  async function action(name: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/orders/${order.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name }),
      });
      const v = await readJson<OrderView>(r, paymentFailure);
      setOrder(v);
      router.refresh();
    } catch (e) {
      setError(requestFailure(e, paymentFailure));
      router.refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (initial.status !== "AWAITING_PAYMENT") return;
    let disposed = false,
      runs = 0,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (disposed) return;
      if (!inFlight.current) {
        inFlight.current = true;
        try {
          const r = await fetch(`/api/orders/${initial.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "refresh" }),
          });
          if (r.ok) {
            const v = await readJson<OrderView>(r, paymentFailure);
            if (!disposed) {
              setOrder(v);
              if (v.status !== "AWAITING_PAYMENT") {
                router.refresh();
                return;
              }
            }
          }
        } catch {
          // A manual refresh remains available after a temporary connection failure.
        } finally {
          inFlight.current = false;
        }
      }
      if (!disposed && ++runs < 12) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [initial.id, initial.status, router]);
  const waiting = order.status === "AWAITING_PAYMENT";
  return (
    <section className="checkout-panel order-panel">
      <span
        className={`order-status order-${order.status.toLowerCase()}`}
        role="status"
      >
        {orderStatusNames[order.status]}
      </span>
      <h2>{formatPrice(order.total)}</h2>
      <p className="checkout-muted">
        Заказ №{order.id.slice(0, 8)} ·{" "}
        {new Date(order.createdAt).toLocaleDateString("ru-RU", {
          timeZone: "Europe/Moscow",
        })}
      </p>
      {order.payment?.needsReview && (
        <p className="form-error" role="alert">
          Платёж требует сверки. Повторная оплата и выдача покупки
          приостановлены.
        </p>
      )}
      {waiting && (
        <>
          {order.payment?.provider === "DEMO" ? (
            <>
              <div className="demo-notice">
                Локальный симулятор. Выбери результат тестового платежа — деньги
                не списываются.
              </div>
              <p className="checkout-muted">
                Оплата доступна до{" "}
                {new Date(order.expiresAt).toLocaleTimeString("ru-RU", {
                  timeZone: "Europe/Moscow",
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                МСК.
              </p>
              <div className="order-actions">
                <button
                  className="primary-button"
                  disabled={busy || order.payment.needsReview}
                  onClick={() => void action("demo-success")}
                >
                  Сымитировать успешную оплату
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void action("demo-cancel")}
                >
                  Сымитировать отказ
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="demo-notice">
                Тестовая оплата ЮKassa. Реальных списаний нет.
              </div>
              {order.payment?.confirmationUrl && !order.payment.needsReview && (
                <a
                  className="primary-button"
                  href={order.payment.confirmationUrl}
                >
                  Перейти к тестовой оплате
                </a>
              )}
              <p className="checkout-muted">
                После возвращения проверим результат. Если оплата ещё доступна в
                ЮKassa, заказ и резерв сохраняются до её завершения или отмены.
              </p>
            </>
          )}
          <div className="order-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void action("refresh")}
            >
              {busy ? "Проверяем…" : "Проверить оплату"}
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void action("cancel")}
            >
              Отменить заказ
            </button>
          </div>
        </>
      )}
      {order.status === "PAID" && (
        <>
          <p>
            Тестовая оплата подтверждена. Покупка сохранена в личном кабинете.
          </p>
          <DeliveryPanel orderId={order.id} delivery={delivery} />
        </>
      )}
      {order.status === "REFUNDED" && (
        <>
          <p>
            Платёж возвращён. Доступ к файлу закрыт; готовый документ
            сохраняется как история покупки.
          </p>
          <DeliveryPanel orderId={order.id} delivery={delivery} />
        </>
      )}
      {order.status === "CANCELLED" && (
        <p>
          Заказ отменён, покупка не выдана. Новую покупку можно оформить из
          карточки доступного товара.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Link className="text-link" href="/account">
        В личный кабинет →
      </Link>
    </section>
  );
}
