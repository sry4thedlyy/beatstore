import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  createEmbeddedDatabase,
  type Database,
} from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "../scripts/seed";
import { getProducts } from "../src/server/catalog/repository";
import { getPublicMedia } from "../src/server/media";

let db: Database;
before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db);
  await seedDemo(db);
});
after(async () => {
  await db?.close();
});

test("migration and seed are repeatable without resetting edited data", async () => {
  await db.query(
    "UPDATE products SET title = 'Midnight Drive edited' WHERE id = $1",
    ["10000000-0000-4000-8000-000000000001"],
  );
  await migrate(db);
  await seedDemo(db);
  const { rows } = await db.query<{
    products: number;
    offers: number;
    migrations: number;
  }>(`SELECT
    (SELECT count(*)::integer FROM products) products, (SELECT count(*)::integer FROM offers) offers,
    (SELECT count(*)::integer FROM schema_migrations) migrations`);
  assert.deepEqual(rows[0], { products: 4, offers: 10, migrations: 3 });
  assert.equal(
    (await getProducts("edited", undefined, db))[0].title,
    "Midnight Drive edited",
  );
});

test("catalog searches literal titles and hides unpublished products", async () => {
  assert.equal((await getProducts("AFTER", undefined, db)).length, 1);
  assert.equal((await getProducts("%", undefined, db)).length, 0);
  assert.equal((await getProducts("_", undefined, db)).length, 0);
  assert.equal((await getProducts("' OR 1=1 --", undefined, db)).length, 0);
  assert.equal((await getProducts("", "invalid-uuid", db)).length, 0);
  const id = "10000000-0000-4000-8000-000000000004";
  await db.query("UPDATE products SET status = 'UNPUBLISHED' WHERE id = $1", [
    id,
  ]);
  assert.equal((await getProducts("", id, db)).length, 0);
  await db.query("UPDATE products SET status = 'PUBLISHED' WHERE id = $1", [
    id,
  ]);
});

test("publication rejects incomplete offers, zero prices and unavailable files", async () => {
  const product = (await getProducts("After", undefined, db))[0];
  const wav = product.offers.find((offer) => offer.kind === "WAV")!;
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("DELETE FROM offers WHERE id = $1", [wav.id]);
    }),
    /valid offers/,
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(
        "UPDATE products SET discount_percent = 100 WHERE id = $1",
        [product.id],
      );
    }),
    /valid offers/,
  );
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("UPDATE files SET status = 'FAILED' WHERE id = $1", [
        product.previewId,
      ]);
    }),
    /ready covers/,
  );
  await assert.rejects(
    db.query(
      "INSERT INTO products (type, title, status) VALUES ('DRUMKIT','Incomplete','PUBLISHED')",
    ),
    /ready covers/,
  );
});

test("private purchase files never pass the public media lookup", async () => {
  const product = (await getProducts("After", undefined, db))[0];
  assert.ok(await getPublicMedia(product.previewId, db));
  const { rows } = await db.query<{ file_id: string }>(
    "SELECT file_id FROM offers WHERE product_id = $1 AND kind IN ('WAV','STEMS','EXCLUSIVE')",
    [product.id],
  );
  for (const row of rows)
    assert.equal(await getPublicMedia(row.file_id, db), null);
});

test("terms cannot be edited in place", async () => {
  await assert.rejects(
    db.query("UPDATE terms_versions SET body = 'Changed' WHERE kind = 'WAV'"),
    /immutable/,
  );
});

test("exclusive uniqueness survives a refund; repeated WAV purchases remain possible", async () => {
  const product = (await getProducts("After", undefined, db))[0];
  const userId = randomUUID();
  await db.query(
    "INSERT INTO users (id,email,artist_name) VALUES ($1,'test@example.test','Test Artist')",
    [userId],
  );
  async function purchase(
    kind: "WAV" | "EXCLUSIVE",
    status: "PAID" | "REFUNDED" = "PAID",
  ) {
    const offer = product.offers.find((option) => option.kind === kind)!;
    return db.query(
      `INSERT INTO orders (user_id,product_id,offer_id,purchase_kind,status,base_price_kopecks,
      discount_percent,total_kopecks,snapshot,expires_at,paid_at,refunded_at)
      VALUES ($1,$2,$3,$4,$5,$6,0,$6,'{}',now() + interval '15 minutes',now(),$7)`,
      [
        userId,
        product.id,
        offer.id,
        kind,
        status,
        offer.basePrice,
        status === "REFUNDED" ? new Date() : null,
      ],
    );
  }
  await purchase("WAV");
  await purchase("WAV");
  await purchase("EXCLUSIVE", "REFUNDED");
  await assert.rejects(purchase("EXCLUSIVE"), /orders_one_exclusive_sale/);
  await assert.rejects(
    db.query("DELETE FROM products WHERE id = $1", [product.id]),
    /foreign key/,
  );
});
