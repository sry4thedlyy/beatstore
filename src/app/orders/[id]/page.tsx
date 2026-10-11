import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db/connection";
import { getOrder } from "@/server/checkout/service";
import { CheckoutError } from "@/domain/checkout";
import { OrderPanel } from "@/components/order-panel";
import { PurchaseConditions } from "@/components/purchase-conditions";
export const metadata = { title: "Заказ" };
export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params,
    user = await requireUser(`/orders/${id}`);
  let order;
  try {
    order = await getOrder(user, id, await getDatabase());
  } catch (e) {
    if (e instanceof CheckoutError && e.status === 404) notFound();
    throw e;
  }
  return (
    <div className="checkout-page">
      <Link className="back-link" href="/account">
        ← Назад в кабинет
      </Link>
      <p className="eyebrow">ТЕСТОВЫЙ ЗАКАЗ</p>
      <h1>{order.snapshot.product.title}</h1>
      <div className="checkout-layout">
        <PurchaseConditions snapshot={order.snapshot} />
        <OrderPanel initial={order} />
      </div>
    </div>
  );
}
