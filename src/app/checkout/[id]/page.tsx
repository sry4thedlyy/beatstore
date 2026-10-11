import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db/connection";
import { getCheckoutQuote } from "@/server/checkout/service";
import { CheckoutError } from "@/domain/checkout";
import { paymentConfig } from "@/server/payments/provider";
import { CheckoutForm } from "@/components/checkout-form";
import { PurchaseConditions } from "@/components/purchase-conditions";
export const metadata = { title: "Оформление заказа" };
export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ license?: string | string[] }>;
}) {
  const { id } = await params,
    kind = (await searchParams).license;
  const user = await requireUser(
    `/checkout/${id}?license=${typeof kind === "string" ? kind : ""}`,
  );
  let quote;
  try {
    quote = await getCheckoutQuote(user, id, kind, await getDatabase());
  } catch (e) {
    if (!(e instanceof CheckoutError)) throw e;
    return (
      <div className="checkout-page">
        <h1>Покупка недоступна</h1>
        <p>{e.message}</p>
        <Link className="primary-button" href="/">
          Вернуться в каталог
        </Link>
      </div>
    );
  }
  return (
    <div className="checkout-page">
      <Link className="back-link" href={`/products/${id}?license=${kind}`}>
        ← Назад к товару
      </Link>
      <p className="eyebrow">ОДИН ТОВАР · ОДНА ПОКУПКА</p>
      <h1>{quote.snapshot.product.title}</h1>
      <div className="checkout-layout">
        <PurchaseConditions snapshot={quote.snapshot} />
        <section className="checkout-panel">
          <h2>Оформление заказа</h2>
          <CheckoutForm
            snapshot={quote.snapshot}
            revision={quote.revision}
            provider={paymentConfig().name}
          />
        </section>
      </div>
    </div>
  );
}
