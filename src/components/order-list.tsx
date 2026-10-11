import Link from "next/link";
import { orderStatusNames, type OrderView } from "@/domain/checkout";
import { formatPrice, offerNames } from "@/domain/pricing";
export function OrderList({
  orders,
  title,
  empty,
}: {
  orders: OrderView[];
  title: string;
  empty: string;
}) {
  return (
    <section className="account-section">
      <div className="section-heading">
        <h2>{title}</h2>
        <span>{orders.length}</span>
      </div>
      {!orders.length ? (
        <p className="account-description">{empty}</p>
      ) : (
        <div className="account-orders">
          {orders.map((order) => (
            <Link
              key={order.id}
              href={`/orders/${order.id}`}
              className="account-order-row"
            >
              <div>
                <strong>{order.snapshot.product.title}</strong>
                <span>
                  {offerNames[order.kind]} · №{order.id.slice(0, 8)}
                </span>
              </div>
              <span
                className={`order-status order-${order.status.toLowerCase()}`}
              >
                {orderStatusNames[order.status]}
              </span>
              <strong>{formatPrice(order.total)}</strong>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
