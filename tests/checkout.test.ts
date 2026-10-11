import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import {
  createEmbeddedDatabase,
  type Database,
} from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "../scripts/seed";
import {
  createOrder,
  getOrder,
  getUserOrders,
  getCheckoutQuote,
  refreshOrder,
  simulateOrder,
  applyVerifiedPayment,
  processNotification,
} from "../src/server/checkout/service";
import {
  createDemoProvider,
  createYooKassaProvider,
  paymentConfig,
  type PaymentProvider,
} from "../src/server/payments/provider";
import type { CurrentUser } from "../src/server/auth/session";
import {
  CheckoutError,
  paymentAmount,
  parseProviderAmount,
} from "../src/domain/checkout";
import { getProducts } from "../src/server/catalog/repository";
import {
  getAdminProductView,
  getEditorProduct,
} from "../src/server/catalog/admin";
import { getPublicMedia } from "../src/server/media";
import { createAuth, type ShopAuth } from "../src/server/auth";
import { handleAuthRequest } from "../src/server/auth/handler";
import {
  handleOrderRequest,
  handlePaymentNotification,
} from "../src/server/checkout/handler";
import { safeReturnTo } from "../src/domain/auth";

let db: Database,
  provider: PaymentProvider,
  buyer: CurrentUser,
  other: CurrentUser;
const origin = "http://127.0.0.1:3000";
before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db);
  await seedDemo(db);
  provider = createDemoProvider(db);
  buyer = await user();
  other = await user();
});
after(async () => {
  await db?.close();
});
async function user() {
  const id = randomUUID(),
    email = `${id}@example.test`;
  await db.query("INSERT INTO users (id,email,artist_name) VALUES ($1,$2,$3)", [
    id,
    email,
    "Test Artist",
  ]);
  return { id, email, name: "Test Artist", role: "CUSTOMER" as const };
}
async function product(type = "BEAT") {
  const id = randomUUID(),
    source =
      type === "BEAT"
        ? "10000000-0000-4000-8000-000000000001"
        : "10000000-0000-4000-8000-000000000003";
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO products(id,type,title,description,status,discount_percent,cover_file_id,thumbnail_file_id,preview_file_id,duration_seconds,authors,bpm,musical_key,royalty_percent,project_requirements) SELECT $1,type,title,description,status,discount_percent,cover_file_id,thumbnail_file_id,preview_file_id,duration_seconds,authors,bpm,musical_key,royalty_percent,project_requirements FROM products WHERE id=$2`,
      [id, source],
    );
    await tx.query(
      `INSERT INTO offers(product_id,kind,base_price_kopecks,file_id,terms_version_id) SELECT $1,kind,base_price_kopecks,file_id,terms_version_id FROM offers WHERE product_id=$2`,
      [id, source],
    );
  });
  return id;
}
async function purchase(
  id: string,
  kind = "WAV",
  who = buyer,
  key = randomUUID(),
  p = provider,
) {
  const quote = await getCheckoutQuote(who, id, kind, db);
  return createOrder(
    who,
    {
      productId: id,
      kind,
      revision: quote.revision,
      accepted: true,
      requestKey: key,
      total: 1,
      userId: other.id,
    },
    db,
    p,
    origin,
  );
}
async function attempt(orderId: string) {
  const { rows } = await db.query<{ id: string; provider_payment_id: string }>(
    "SELECT id,provider_payment_id FROM payments WHERE order_id=$1",
    [orderId],
  );
  return rows[0];
}

test("server snapshots exact prices, authors, terms and file; repeated requests create one order, separate purchases remain separate", async () => {
  const id = await product(),
    key = randomUUID(),
    first = await purchase(id, "WAV", buyer, key),
    same = await purchase(id, "WAV", buyer, key);
  assert.equal(first.total, 180000);
  assert.equal(same.id, first.id);
  assert.equal(first.status, "AWAITING_PAYMENT");
  assert.equal(first.snapshot.buyer.id, buyer.id);
  assert.deepEqual(first.snapshot.product.authors, ["sry4thedlyy"]);
  assert.equal(first.snapshot.license.tracks, 1);
  assert.equal("trackName" in first.snapshot, false);
  const { rows } = await db.query<{
    files: number;
    payments: number;
    accepted: boolean;
  }>(
    `SELECT (SELECT count(*)::integer FROM order_files WHERE order_id=$1) files,(SELECT count(*)::integer FROM payments WHERE order_id=$1) payments,accepted_at IS NOT NULL accepted FROM orders WHERE id=$1`,
    [first.id],
  );
  assert.deepEqual(rows[0], { files: 1, payments: 1, accepted: true });
  const paid = await simulateOrder(
    buyer,
    first.id,
    "succeeded",
    db,
    provider,
    origin,
  );
  assert.equal(paid.status, "PAID");
  assert.ok(paid.paidAt);
  assert.equal(await getPublicMedia(first.snapshot.file.id, db), null);
  assert.equal(
    (await simulateOrder(buyer, first.id, "succeeded", db, provider, origin))
      .paidAt,
    paid.paidAt,
  );
  const second = await purchase(id);
  assert.notEqual(second.id, first.id);
  await simulateOrder(buyer, second.id, "canceled", db, provider, origin);
  await db.query(
    `UPDATE products SET title='New title',description='New description',authors=ARRAY['New author'],discount_percent=20 WHERE id=$1`,
    [id],
  );
  const preserved = await getOrder(buyer, first.id, db);
  assert.equal(preserved.snapshot.product.title, "Midnight Drive");
  assert.ok(first.snapshot.product.description.length > 0);
  assert.equal(
    preserved.snapshot.product.description,
    first.snapshot.product.description,
  );
  assert.equal(preserved.total, 180000);
  assert.deepEqual(preserved.snapshot.product.authors, ["sry4thedlyy"]);
  assert.equal(preserved.snapshot.file.id, first.snapshot.file.id);
  await assert.rejects(
    getOrder(other, first.id, db),
    (e) => e instanceof CheckoutError && e.status === 404,
  );
  assert.ok(!(await getUserOrders(other, db)).some((o) => o.id === first.id));
});
test("exclusive waits for ordinary payments, reserves all variants and disappears only after verified success", async () => {
  const id = await product(),
    normal = await purchase(id);
  const admin: CurrentUser = { ...(await user()), role: "ADMIN" };
  await db.query("UPDATE users SET role='ADMIN' WHERE id=$1", [admin.id]);
  assert.equal((await getEditorProduct(admin, id, db)).locked, true);
  assert.equal((await getAdminProductView(admin, id, db)).reserved, false);
  await assert.rejects(purchase(id, "EXCLUSIVE"), /незавершённые/);
  await simulateOrder(buyer, normal.id, "succeeded", db, provider, origin);
  const exclusive = await purchase(id, "EXCLUSIVE");
  assert.equal((await getAdminProductView(admin, id, db)).reserved, true);
  assert.equal(exclusive.total, 1500000);
  assert.equal(exclusive.snapshot.price.discount, "0.00");
  assert.equal(exclusive.snapshot.product.royalty, "10.00");
  for (const kind of ["MP3", "WAV", "STEMS", "EXCLUSIVE"])
    await assert.rejects(purchase(id, kind, other), /зарезервирован/);
  await simulateOrder(buyer, exclusive.id, "succeeded", db, provider, origin);
  assert.equal((await getProducts("", id, db)).length, 0);
  await assert.rejects(purchase(id, "EXCLUSIVE", other), /не доступен/);
  assert.equal((await getOrder(buyer, normal.id, db)).status, "PAID");
  const { rows } = await db.query<{
    status: string;
    reserved_order_id: null;
    exclusive_order_id: string;
  }>(
    "SELECT status,reserved_order_id,exclusive_order_id FROM products WHERE id=$1",
    [id],
  );
  assert.deepEqual(rows[0], {
    status: "EXCLUSIVE_SOLD",
    reserved_order_id: null,
    exclusive_order_id: exclusive.id,
  });
});
test("cancel and expiry release a simulator reserve; return URLs and elapsed external timers never prove payment or cancellation", async () => {
  const id = await product(),
    ex = await purchase(id, "EXCLUSIVE");
  assert.equal(
    (await refreshOrder(buyer, ex.id, db, provider, origin)).status,
    "AWAITING_PAYMENT",
  );
  await db.query(
    `UPDATE demo_provider_payments SET expires_at=now()-interval '1 second' WHERE order_id=$1`,
    [ex.id],
  );
  assert.equal(
    (await simulateOrder(buyer, ex.id, "succeeded", db, provider, origin))
      .status,
    "CANCELLED",
  );
  const newEx = await purchase(id, "EXCLUSIVE");
  assert.notEqual(newEx.id, ex.id);
  assert.equal(
    (await refreshOrder(buyer, newEx.id, db, provider, origin, true)).status,
    "CANCELLED",
  );
  const ext: PaymentProvider = { ...provider, name: "YOOKASSA" };
  const extOrder = await purchase(id, "EXCLUSIVE", buyer, randomUUID(), ext);
  await db.query(
    `UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=$1`,
    [extOrder.id],
  );
  assert.equal(
    (await refreshOrder(buyer, extOrder.id, db, ext, origin)).status,
    "AWAITING_PAYMENT",
  );
  await assert.rejects(
    purchase(id, "WAV", other, randomUUID(), ext),
    /зарезервирован/,
  );
  await refreshOrder(buyer, extOrder.id, db, ext, origin, true);
});
test("wrong amount, currency, environment or metadata never grants a purchase; late success is quarantined", async () => {
  const id = await product(),
    order = await purchase(id, "EXCLUSIVE"),
    a = await attempt(order.id),
    valid = await provider.get(a.provider_payment_id);
  for (const changes of [
    { amount: 1 },
    { currency: "USD" },
    { test: false },
    { orderId: randomUUID() },
    { attemptId: randomUUID() },
    { paid: false },
  ]) {
    await applyVerifiedPayment(
      order.id,
      a.id,
      { ...valid, status: "succeeded", paid: true, ...changes },
      db,
    );
    const current = await getOrder(buyer, order.id, db);
    assert.equal(current.status, "AWAITING_PAYMENT");
    assert.equal(current.payment!.needsReview, true);
  }
  await refreshOrder(buyer, order.id, db, provider, origin, true);
  await applyVerifiedPayment(
    order.id,
    a.id,
    { ...valid, status: "succeeded", paid: true },
    db,
  );
  assert.equal((await getOrder(buyer, order.id, db)).status, "CANCELLED");
  assert.equal(
    (await getOrder(buyer, order.id, db)).payment!.needsReview,
    true,
  );
  await assert.rejects(purchase(id), /уточняется/);
});
test("uncertain provider creation retries the original key; attempts older than the idempotence window stay blocked", async () => {
  const id = await product(),
    seen: string[] = [];
  const uncertain: PaymentProvider = {
    ...provider,
    async create(intent) {
      seen.push(intent.key);
      await provider.create(intent);
      throw new CheckoutError(503, "Timeout");
    },
  };
  const order = await purchase(id, "EXCLUSIVE", buyer, randomUUID(), uncertain);
  assert.equal(order.payment!.status, "CREATING");
  await refreshOrder(buyer, order.id, db, provider, origin);
  assert.equal(
    (await getOrder(buyer, order.id, db)).payment!.status,
    "PENDING",
  );
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::integer n FROM demo_provider_payments WHERE order_id=$1",
    [order.id],
  );
  assert.equal(rows[0].n, 1);
  assert.equal(seen.length, 1);
  await refreshOrder(buyer, order.id, db, provider, origin, true);
  const second = await purchase(
    await product(),
    "EXCLUSIVE",
    buyer,
    randomUUID(),
    {
      ...provider,
      create: async () => {
        throw new CheckoutError(503, "Offline");
      },
    },
  );
  await db.query(
    `UPDATE payments SET created_at=now()-interval '24 hours' WHERE order_id=$1`,
    [second.id],
  );
  await assert.rejects(
    refreshOrder(buyer, second.id, db, provider, origin),
    /требует проверки/,
  );
  assert.equal(
    (await getOrder(buyer, second.id, db)).payment!.needsReview,
    true,
  );
});
test("API isolates orders, checks origin and JSON limits, and ignores forged webhook success", async () => {
  const auth: ShopAuth = createAuth(db, {
    baseURL: origin,
    secret: "A-checkout-only-secret-that-is-longer-than-32-characters",
  });
  async function register() {
    const r = await handleAuthRequest(
      auth,
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "API Artist",
          email: `${randomUUID()}@example.test`,
          password: "Checkout-api-password-2026",
        }),
      }),
    );
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie")!.split(";")[0];
  }
  const cookie = await register(),
    foreign = await register(),
    id = await product("DRUMKIT");
  const req = (data: unknown, c = cookie, site = origin) =>
    new Request(`${origin}/api/orders`, {
      method: "POST",
      headers: { Origin: site, Cookie: c, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const input = {
    productId: id,
    kind: "DRUMKIT",
    revision: 1,
    requestKey: randomUUID(),
    accepted: true,
  };
  assert.equal(
    (await handleOrderRequest(db, auth, req(input, ""), undefined, provider))
      .status,
    401,
  );
  assert.equal(
    (
      await handleOrderRequest(
        db,
        auth,
        req(input, cookie, "https://outside.example"),
        undefined,
        provider,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleOrderRequest(
        db,
        auth,
        req({ ...input, ignored: "x".repeat(9000) }),
        undefined,
        provider,
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await handleOrderRequest(
        db,
        auth,
        req({ ...input, accepted: false }),
        undefined,
        provider,
      )
    ).status,
    400,
  );
  const response = await handleOrderRequest(
    db,
    auth,
    req(input),
    undefined,
    provider,
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const order = await response.json();
  assert.equal(
    (
      await handleOrderRequest(
        db,
        auth,
        req({ action: "demo-success" }, foreign),
        order.id,
        provider,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await handleOrderRequest(
        db,
        auth,
        new Request(`${origin}/api/orders/${order.id}?status=PAID`, {
          headers: { Cookie: cookie },
        }),
        order.id,
        provider,
      )
    ).status,
    200,
  );
  const a = await attempt(order.id);
  const external: PaymentProvider = { ...provider, name: "YOOKASSA" };
  await db.query(
    `UPDATE payments SET provider='YOOKASSA',checked_at=NULL WHERE id=$1`,
    [a.id],
  );
  await processNotification(
    {
      type: "notification",
      event: "payment.succeeded",
      object: { id: a.provider_payment_id, status: "succeeded", paid: true },
    },
    db,
    external,
    origin,
  );
  assert.equal(
    (
      await db.query<{ status: string }>(
        "SELECT status FROM orders WHERE id=$1",
        [order.id],
      )
    ).rows[0].status,
    "AWAITING_PAYMENT",
  );
  assert.equal(
    (
      await handlePaymentNotification(
        db,
        req({ type: "notification" }),
        provider,
        origin,
      )
    ).status,
    404,
  );
  await db.query(`UPDATE payments SET provider='DEMO' WHERE id=$1`, [a.id]);
  assert.equal(
    (
      await handleOrderRequest(
        db,
        auth,
        req({ action: "demo-success" }),
        order.id,
        provider,
      )
    ).status,
    200,
  );
});
test("YooKassa adapter uses only test credentials, a stable key and exact RUB; validates responses and redirects", async () => {
  assert.equal(paymentAmount(70124), "701.24");
  assert.equal(parseProviderAmount("701.24"), 70124);
  assert.throws(() => parseProviderAmount("1e3"));
  assert.throws(() => createYooKassaProvider("100", "live_key"));
  assert.throws(() =>
    paymentConfig({
      BETTER_AUTH_SECRET: "x".repeat(40),
      PAYMENT_PROVIDER: "yookassa",
      YOOKASSA_SHOP_ID: "100",
      YOOKASSA_SECRET_KEY: "live_key",
    }),
  );
  const intent = {
    id: randomUUID(),
    orderId: randomUUID(),
    key: randomUUID(),
    amount: 70124,
    description: "Test",
    returnUrl: `${origin}/orders/${randomUUID()}`,
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  };
  const payload = {
    id: randomUUID(),
    status: "pending",
    paid: false,
    test: true,
    amount: { value: "701.24", currency: "RUB" },
    recipient: { account_id: "100" },
    metadata: { order_id: intent.orderId, payment_id: intent.id },
    confirmation: {
      type: "redirect",
      confirmation_url: "https://yoomoney.ru/checkout/test",
    },
  };
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://api.yookassa.ru/v3/payments");
    assert.equal(
      (options!.headers as Record<string, string>)["Idempotence-Key"],
      intent.key,
    );
    const sent = JSON.parse(String(options!.body));
    assert.deepEqual(sent.amount, { value: "701.24", currency: "RUB" });
    assert.equal(sent.capture, true);
    assert.deepEqual(sent.metadata, {
      order_id: intent.orderId,
      payment_id: intent.id,
    });
    return Response.json(payload);
  };
  assert.equal(
    (await createYooKassaProvider("100", "test_key", fetcher).create(intent))
      .test,
    true,
  );
  assert.equal(calls, 1);
  for (const changes of [
    { test: false },
    { recipient: { account_id: "101" } },
    {
      confirmation: {
        type: "redirect",
        confirmation_url: "https://outside.example/payment",
      },
    },
  ])
    await assert.rejects(
      createYooKassaProvider("100", "test_key", async () =>
        Response.json({ ...payload, ...changes }),
      ).create(intent),
    );
  assert.equal(
    safeReturnTo(
      `/checkout/${intent.orderId}?license=DRUMKIT&next=https://outside.example`,
    ),
    `/checkout/${intent.orderId}?license=DRUMKIT`,
  );
  assert.equal(
    safeReturnTo(`/orders/${intent.orderId}?status=PAID`),
    `/orders/${intent.orderId}`,
  );
});
