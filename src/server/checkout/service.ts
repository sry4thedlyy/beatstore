import "server-only";
import { randomUUID } from "node:crypto";
import {
  CheckoutError,
  LOCAL_PAYMENT_MINUTES,
  type OrderView,
  type PurchaseSnapshot,
  type OrderStatus,
} from "../../domain/checkout";
import { calculatePrice, type OfferKind } from "../../domain/pricing";
import { isUuid } from "../catalog/repository";
import type { CurrentUser } from "../auth/session";
import type { Database, SqlConnection } from "../db/connection";
import type { PaymentProvider, ProviderPayment } from "../payments/provider";

interface QuoteRow {
  id: string;
  type: "BEAT" | "DRUMKIT";
  title: string;
  description: string;
  status: string;
  revision: number;
  authors: string[] | null;
  bpm: number | null;
  musical_key: string | null;
  royalty_percent: string | null;
  project_requirements: string | null;
  discount_percent: string;
  reserved_order_id: string | null;
  exclusive_order_id: string | null;
  offer_id: string;
  kind: OfferKind;
  base_price_kopecks: number;
  file_id: string;
  original_name: string;
  file_kind: string;
  checksum: string;
  terms_id: string;
  terms_version: string;
  body: string;
  parameters: Record<string, unknown>;
}
const quoteSQL = `SELECT p.*,o.id AS offer_id,o.kind,o.base_price_kopecks,f.id AS file_id,f.original_name,f.kind AS file_kind,f.checksum,t.id AS terms_id,t.version AS terms_version,t.body,t.parameters
  FROM products p JOIN offers o ON o.product_id=p.id JOIN files f ON f.id=o.file_id AND f.status='READY'
  JOIN terms_versions t ON t.id=o.terms_version_id AND t.kind=o.kind WHERE p.id=$1 AND o.kind=$2`;
async function quoteRow(
  db: SqlConnection,
  id: string,
  kind: unknown,
  lock = false,
) {
  if (
    !isUuid(id) ||
    !["MP3", "WAV", "STEMS", "EXCLUSIVE", "DRUMKIT"].includes(String(kind))
  )
    throw new CheckoutError(404, "Вариант покупки не найден.");
  const { rows } = await db.query<QuoteRow>(
    quoteSQL + (lock ? " FOR UPDATE OF p" : ""),
    [id, kind],
  );
  if (!rows[0]) throw new CheckoutError(404, "Вариант покупки не найден.");
  return rows[0];
}
function available(row: QuoteRow) {
  if (row.status !== "PUBLISHED" || row.exclusive_order_id)
    throw new CheckoutError(409, "Товар больше не доступен для покупки.");
  if (row.reserved_order_id)
    throw new CheckoutError(
      409,
      "Бит зарезервирован для покупки эксклюзива. Попробуй позже.",
    );
}
function snapshot(row: QuoteRow, buyer: CurrentUser): PurchaseSnapshot {
  const discount = row.kind === "EXCLUSIVE" ? "0.00" : row.discount_percent;
  return {
    version: 1,
    demonstration: true,
    product: {
      id: row.id,
      title: row.title,
      description: row.description,
      type: row.type,
      authors: row.authors ?? [],
      bpm: row.bpm,
      musicalKey: row.musical_key,
      royalty: row.royalty_percent,
      projectRequirements: row.project_requirements,
    },
    buyer: { id: buyer.id, name: buyer.name, email: buyer.email },
    seller: { name: "Demo Producer", email: "seller@example.test" },
    terms: {
      id: row.terms_id,
      version: row.terms_version,
      body: row.body,
      parameters: row.parameters,
    },
    license: {
      kind: row.kind,
      tracks: ["MP3", "WAV", "STEMS"].includes(row.kind) ? 1 : null,
      streamLimitPerPlatform: ["MP3", "WAV", "STEMS"].includes(row.kind)
        ? 500000
        : null,
      royaltyBasis:
        row.kind === "EXCLUSIVE" ? "Доход от стриминга после комиссий" : null,
      reporting:
        row.kind === "EXCLUSIVE"
          ? "Календарные кварталы; отчёт и выплата в течение 15 календарных дней"
          : null,
    },
    file: {
      id: row.file_id,
      name: row.original_name,
      kind: row.file_kind,
      checksum: row.checksum,
    },
    price: {
      base: row.base_price_kopecks,
      discount,
      total: calculatePrice(row.base_price_kopecks, discount, row.kind),
      currency: "RUB",
    },
  };
}
export async function getCheckoutQuote(
  user: CurrentUser,
  id: string,
  kind: unknown,
  db: Database,
) {
  const row = await quoteRow(db, id, kind);
  available(row);
  return { revision: row.revision, snapshot: snapshot(row, user) };
}
interface OrderRow {
  id: string;
  user_id: string;
  product_id: string | null;
  status: OrderStatus;
  purchase_kind: OfferKind;
  total_kopecks: number;
  snapshot: PurchaseSnapshot;
  created_at: Date;
  expires_at: Date;
  paid_at: Date | null;
}
interface AttemptRow {
  id: string;
  order_id: string;
  provider: PaymentProvider["name"];
  status: string;
  provider_payment_id: string | null;
  idempotency_key: string;
  amount_kopecks: number;
  confirmation_url: string | null;
  needs_review: boolean;
  created_at: Date;
  checked_at: Date | null;
}
async function orderRow(
  db: SqlConnection,
  id: string,
  userId?: string,
): Promise<OrderRow> {
  if (!isUuid(id)) throw new CheckoutError(404, "Заказ не найден.");
  const { rows } = await db.query<OrderRow>(
    `SELECT * FROM orders WHERE id=$1 ${userId ? "AND user_id=$2" : ""}`,
    userId ? [id, userId] : [id],
  );
  if (!rows[0]) throw new CheckoutError(404, "Заказ не найден.");
  return rows[0];
}
async function attemptRow(db: SqlConnection, orderId: string) {
  const { rows } = await db.query<AttemptRow>(
    `SELECT * FROM payments WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [orderId],
  );
  return rows[0];
}
function view(row: OrderRow, attempt?: AttemptRow): OrderView {
  return {
    id: row.id,
    status: row.status,
    kind: row.purchase_kind,
    total: row.total_kopecks,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    paidAt: row.paid_at?.toISOString() ?? null,
    snapshot: row.snapshot,
    payment: attempt
      ? {
          provider: attempt.provider,
          status: attempt.status,
          confirmationUrl: attempt.confirmation_url,
          needsReview: attempt.needs_review,
        }
      : null,
  };
}
export async function getOrder(user: CurrentUser, id: string, db: Database) {
  const row = await orderRow(db, id, user.id);
  return view(row, await attemptRow(db, id));
}
export async function getUserOrders(user: CurrentUser, db: Database) {
  const { rows } = await db.query<OrderRow>(
    `SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC,id DESC`,
    [user.id],
  );
  return rows.map((row) => view(row));
}
async function existingRequest(
  user: CurrentUser,
  key: string,
  productId: string,
  kind: unknown,
  db: SqlConnection,
) {
  const { rows } = await db.query<OrderRow>(
    "SELECT * FROM orders WHERE user_id=$1 AND request_key=$2",
    [user.id, key],
  );
  const row = rows[0];
  if (
    row &&
    (row.snapshot.product.id !== productId || row.purchase_kind !== kind)
  )
    throw new CheckoutError(
      409,
      "Этот запрос уже использован для другой покупки.",
    );
  return row;
}
export async function createOrder(
  user: CurrentUser,
  body: Record<string, unknown>,
  db: Database,
  provider: PaymentProvider,
  baseURL: string,
): Promise<OrderView> {
  const id = String(body.productId),
    key = String(body.requestKey),
    kind = body.kind;
  if (
    !isUuid(key) ||
    !isUuid(id) ||
    !Number.isInteger(body.revision) ||
    body.accepted !== true
  )
    throw new CheckoutError(
      400,
      "Проверь товар и отметь ознакомление с демонстрационными условиями.",
    );
  let existing = await existingRequest(user, key, id, kind, db);
  if (existing) return refreshOrder(user, existing.id, db, provider, baseURL);
  // Reconcile expired simulator payments before availability checks. External expiry alone never releases a reserve.
  const { rows: pending } = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE product_id=$1 AND status='AWAITING_PAYMENT' AND (expires_at<=now() OR $2::boolean) ORDER BY created_at LIMIT 20`,
    [id, kind === "EXCLUSIVE"],
  );
  for (const order of pending)
    await reconcileOrder(order.id, db, provider, baseURL);
  let orderId: string;
  try {
    orderId = await db.transaction(async (tx) => {
      // Serializes a buyer's pending limit across products; all creation locks use this order.
      const { rows: users } = await tx.query<{
        id: string;
        email: string;
        artist_name: string;
        role: string;
      }>("SELECT id,email,artist_name,role FROM users WHERE id=$1 FOR UPDATE", [
        user.id,
      ]);
      if (!users[0]) throw new CheckoutError(401, "Войди в аккаунт.");
      const buyer = {
        ...user,
        email: users[0].email,
        name: users[0].artist_name,
      };
      existing = await existingRequest(buyer, key, id, kind, tx);
      if (existing) return existing.id;
      const row = await quoteRow(tx, id, kind, true);
      available(row);
      if (row.revision !== body.revision)
        throw new CheckoutError(
          409,
          "Карточка изменилась. Обнови страницу и проверь цену и условия.",
        );
      const { rows: flags } = await tx.query<{
        awaiting: number;
        review: boolean;
        mine: number;
      }>(
        `SELECT
        (SELECT count(*)::integer FROM orders WHERE product_id=$1 AND status='AWAITING_PAYMENT') awaiting,
        EXISTS(SELECT 1 FROM payments a JOIN orders o ON o.id=a.order_id WHERE o.product_id=$1 AND a.needs_review) review,
        (SELECT count(*)::integer FROM orders WHERE user_id=$2 AND status='AWAITING_PAYMENT') mine`,
        [id, user.id],
      );
      if (flags[0].review)
        throw new CheckoutError(
          409,
          "Доступность товара уточняется. Попробуй позже.",
        );
      if (row.kind === "EXCLUSIVE" && flags[0].awaiting)
        throw new CheckoutError(
          409,
          "Есть незавершённые покупки лицензий этого бита. Эксклюзив станет доступен после их завершения.",
        );
      if (flags[0].mine >= 5)
        throw new CheckoutError(
          409,
          "Заверши или отмени незавершённые заказы перед новой покупкой.",
        );
      const purchase = snapshot(row, buyer),
        newId = randomUUID();
      const minutes =
        provider.name === "DEMO" ? LOCAL_PAYMENT_MINUTES : 24 * 60;
      const expiry = new Date(Date.now() + minutes * 60_000).toISOString();
      await tx.query(
        `INSERT INTO orders (id,user_id,product_id,offer_id,purchase_kind,base_price_kopecks,discount_percent,total_kopecks,snapshot,expires_at,request_key,accepted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
        [
          newId,
          user.id,
          id,
          row.offer_id,
          row.kind,
          purchase.price.base,
          purchase.price.discount,
          purchase.price.total,
          JSON.stringify(purchase),
          expiry,
          key,
        ],
      );
      await tx.query(
        "INSERT INTO order_files (order_id,file_id) VALUES ($1,$2)",
        [newId, row.file_id],
      );
      const attemptId = randomUUID();
      await tx.query(
        `INSERT INTO payments (id,order_id,provider,idempotency_key,status,amount_kopecks) VALUES ($1,$2,$3,$4,'CREATING',$5)`,
        [attemptId, newId, provider.name, randomUUID(), purchase.price.total],
      );
      if (row.kind === "EXCLUSIVE")
        await tx.query(
          `UPDATE products SET reserved_order_id=$2,reservation_expires_at=$3,revision=revision+1,updated_at=now() WHERE id=$1`,
          [id, newId, expiry],
        );
      return newId;
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const prior = await existingRequest(user, key, id, kind, db);
    if (!prior) throw error;
    orderId = prior.id;
  }
  // Network failure leaves a durable CREATING attempt, retried with the same key.
  try {
    await reconcileOrder(orderId, db, provider, baseURL);
  } catch (error) {
    if (!(error instanceof CheckoutError))
      console.error("Payment creation needs reconciliation");
  }
  return getOrder(user, orderId, db);
}
export async function applyVerifiedPayment(
  orderId: string,
  attemptId: string,
  result: ProviderPayment,
  db: Database,
) {
  const before = await orderRow(db, orderId);
  if (!before.product_id) {
    if (result.status === "succeeded")
      await db.query(
        "UPDATE payments SET needs_review=true WHERE id=$1 AND order_id=$2",
        [attemptId, orderId],
      );
    return;
  }
  await db.transaction(async (tx) => {
    const { rows: products } = await tx.query<{
      status: string;
      reserved_order_id: string | null;
      exclusive_order_id: string | null;
    }>(
      "SELECT status,reserved_order_id,exclusive_order_id FROM products WHERE id=$1 FOR UPDATE",
      [before.product_id],
    );
    const { rows: orders } = await tx.query<OrderRow>(
      "SELECT * FROM orders WHERE id=$1 FOR UPDATE",
      [orderId],
    );
    const { rows: attempts } = await tx.query<AttemptRow>(
      "SELECT * FROM payments WHERE id=$1 AND order_id=$2 FOR UPDATE",
      [attemptId, orderId],
    );
    const order = orders[0],
      attempt = attempts[0],
      product = products[0];
    if (!order || !attempt || !product)
      throw new CheckoutError(409, "Платёж требует проверки.");
    const valid =
      isUuid(result.id) &&
      ["pending", "waiting_for_capture", "succeeded", "canceled"].includes(
        result.status,
      ) &&
      result.test === true &&
      result.currency === "RUB" &&
      result.amount === order.total_kopecks &&
      result.amount === attempt.amount_kopecks &&
      result.orderId === order.id &&
      result.attemptId === attempt.id &&
      (!attempt.provider_payment_id ||
        attempt.provider_payment_id === result.id) &&
      (result.status !== "succeeded" || result.paid === true);
    if (!valid) {
      await tx.query(
        "UPDATE payments SET needs_review=true,checked_at=now() WHERE id=$1",
        [attempt.id],
      );
      return;
    }
    if (
      attempt.status === "SUCCEEDED" ||
      order.status === "PAID" ||
      order.status === "REFUNDED"
    )
      return;
    // Stale PENDING never regresses a terminal status. Late success stays quarantined.
    if (order.status !== "AWAITING_PAYMENT" || attempt.status === "CANCELLED") {
      if (result.status === "succeeded")
        await tx.query(
          "UPDATE payments SET needs_review=true,checked_at=now() WHERE id=$1",
          [attempt.id],
        );
      return;
    }
    const isExclusive = order.purchase_kind === "EXCLUSIVE";
    if (
      result.status === "succeeded" &&
      (product.status !== "PUBLISHED" ||
        product.exclusive_order_id ||
        (isExclusive
          ? product.reserved_order_id !== order.id
          : product.reserved_order_id !== null))
    ) {
      await tx.query(
        "UPDATE payments SET needs_review=true,checked_at=now() WHERE id=$1",
        [attempt.id],
      );
      return;
    }
    const status =
      result.status === "succeeded"
        ? "SUCCEEDED"
        : result.status === "canceled"
          ? "CANCELLED"
          : "PENDING";
    await tx.query(
      `UPDATE payments SET provider_payment_id=$2,status=$3,confirmation_url=$4,checked_at=now(),needs_review=false,updated_at=now() WHERE id=$1`,
      [attempt.id, result.id, status, result.confirmationUrl],
    );
    if (status === "SUCCEEDED") {
      await tx.query(
        `UPDATE orders SET status='PAID',paid_at=now() WHERE id=$1`,
        [order.id],
      );
      if (order.purchase_kind !== "DRUMKIT")
        await tx.query(
          `INSERT INTO documents(order_id,template_version_id) VALUES($1,$2) ON CONFLICT(order_id) DO NOTHING`,
          [order.id, order.snapshot.terms.id],
        );
      if (isExclusive)
        await tx.query(
          `UPDATE products SET status='EXCLUSIVE_SOLD',exclusive_order_id=$2,reserved_order_id=NULL,reservation_expires_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1`,
          [order.product_id, order.id],
        );
    } else if (status === "CANCELLED") {
      await tx.query(`UPDATE orders SET status='CANCELLED' WHERE id=$1`, [
        order.id,
      ]);
      if (isExclusive)
        await tx.query(
          `UPDATE products SET reserved_order_id=NULL,reservation_expires_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND reserved_order_id=$2`,
          [order.product_id, order.id],
        );
    }
  });
}
export async function reconcileOrder(
  id: string,
  db: Database,
  provider: PaymentProvider,
  baseURL: string,
  cancel = false,
) {
  const order = await orderRow(db, id),
    attempt = await attemptRow(db, id);
  if (!attempt || order.status !== "AWAITING_PAYMENT") return;
  if (attempt.provider !== provider.name)
    throw new CheckoutError(
      409,
      "Для этого заказа требуется исходный режим оплаты.",
    );
  if (
    attempt.status === "CREATING" &&
    Date.now() - attempt.created_at.getTime() >= 23 * 60 * 60_000
  ) {
    await db.query("UPDATE payments SET needs_review=true WHERE id=$1", [
      attempt.id,
    ]);
    throw new CheckoutError(
      409,
      "Создание платежа требует проверки. Повторная оплата не открыта.",
    );
  }
  const lease = randomUUID();
  const { rows } = await db.query<{ id: string }>(
    `UPDATE payments SET lease_token=$2,lease_until=now()+interval '30 seconds' WHERE id=$1 AND (lease_until IS NULL OR lease_until<=now()) RETURNING id`,
    [attempt.id, lease],
  );
  if (!rows.length) return;
  try {
    let result = attempt.provider_payment_id
      ? await provider.get(attempt.provider_payment_id)
      : await provider.create({
          id: attempt.id,
          orderId: order.id,
          key: attempt.idempotency_key,
          amount: order.total_kopecks,
          description: `Beatstore: ${order.snapshot.product.title}`,
          returnUrl: `${baseURL}/orders/${order.id}`,
          expiresAt: order.expires_at.toISOString(),
        });
    if (cancel && ["pending", "waiting_for_capture"].includes(result.status))
      result = await provider.cancel(result.id);
    await applyVerifiedPayment(id, attempt.id, result, db);
  } catch (error) {
    if (error instanceof CheckoutError && error.status === 502)
      await db.query("UPDATE payments SET needs_review=true WHERE id=$1", [
        attempt.id,
      ]);
    throw error;
  } finally {
    await db.query(
      "UPDATE payments SET lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2",
      [attempt.id, lease],
    );
  }
}
export async function refreshOrder(
  user: CurrentUser,
  id: string,
  db: Database,
  provider: PaymentProvider,
  baseURL: string,
  cancel = false,
) {
  await orderRow(db, id, user.id);
  await reconcileOrder(id, db, provider, baseURL, cancel);
  return getOrder(user, id, db);
}
export async function simulateOrder(
  user: CurrentUser,
  id: string,
  outcome: "succeeded" | "canceled",
  db: Database,
  provider: PaymentProvider,
  baseURL: string,
) {
  await orderRow(db, id, user.id);
  if (provider.name !== "DEMO" || !provider.simulate)
    throw new CheckoutError(404, "Симулятор недоступен.");
  await reconcileOrder(id, db, provider, baseURL);
  const attempt = await attemptRow(db, id);
  if (attempt?.provider_payment_id)
    await provider.simulate(attempt.provider_payment_id, outcome);
  return refreshOrder(user, id, db, provider, baseURL);
}
export async function processNotification(
  body: Record<string, unknown>,
  db: Database,
  provider: PaymentProvider,
  baseURL: string,
) {
  if (provider.name !== "YOOKASSA")
    throw new CheckoutError(404, "Маршрут недоступен.");
  const object = body.object as Record<string, unknown> | undefined;
  if (
    body.type !== "notification" ||
    ![
      "payment.succeeded",
      "payment.canceled",
      "payment.waiting_for_capture",
    ].includes(String(body.event)) ||
    !object ||
    !isUuid(String(object.id))
  )
    throw new CheckoutError(400, "Некорректное уведомление.");
  const { rows } = await db.query<AttemptRow>(
    `SELECT * FROM payments WHERE provider='YOOKASSA' AND environment='TEST' AND provider_payment_id=$1`,
    [object.id],
  );
  if (!rows[0]) return; // Early notification is recovered by server-side polling after creation.
  if (rows[0].checked_at && Date.now() - rows[0].checked_at.getTime() < 3000)
    return rows[0].order_id;
  if (rows[0].status === "CANCELLED") {
    await applyVerifiedPayment(
      rows[0].order_id,
      rows[0].id,
      await provider.get(String(object.id)),
      db,
    );
    return rows[0].order_id;
  }
  // Notification payload never determines payment status; read authenticated API state.
  await reconcileOrder(rows[0].order_id, db, provider, baseURL);
  return rows[0].order_id;
}
