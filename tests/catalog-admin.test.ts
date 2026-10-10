import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import sharp from "sharp";
import {
  createEmbeddedDatabase,
  type Database,
} from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "../scripts/seed";
import { zip } from "../scripts/generate-demo-assets";
import {
  createProduct,
  deleteProduct,
  getEditorProduct,
  saveProduct,
} from "../src/server/catalog/admin";
import { uploadProductFile } from "../src/server/catalog/uploads";
import { getProducts } from "../src/server/catalog/repository";
import {
  getAdminMedia,
  getPublicMedia,
  mediaResponse,
} from "../src/server/media";
import {
  CatalogError,
  decimal,
  rubles,
  STORAGE_LIMIT,
  type EditorProduct,
  type UploadKind,
} from "../src/domain/catalog-editor";
import type { CurrentUser } from "../src/server/auth/session";
import { createAuth, type ShopAuth } from "../src/server/auth";
import { handleAuthRequest } from "../src/server/auth/handler";
import { handleCatalogRequest } from "../src/server/catalog/handler";

let db: Database,
  root: string,
  admin: CurrentUser,
  customer: CurrentUser,
  auth: ShopAuth,
  adminCookie: string,
  customerCookie: string;
const origin = "http://127.0.0.1:3000";
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "beatstore-upload-tests-"));
  db = await createEmbeddedDatabase();
  await migrate(db);
  await seedDemo(db);
  auth = createAuth(db, {
    secret: "A-separate-catalog-test-secret-with-48-characters",
    baseURL: origin,
  });
  async function register(email: string) {
    const result = await handleAuthRequest(
      auth,
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Artist",
          email,
          password: "Test-account-password-2026",
        }),
      }),
    );
    assert.equal(result.status, 200);
    const body = await result.json();
    return {
      user: {
        id: body.user.id,
        email,
        name: body.user.name,
        role: "CUSTOMER" as const,
      },
      cookie: result.headers.get("set-cookie")!.split(";")[0],
    };
  }
  const a = await register("admin-catalog@example.test"),
    c = await register("buyer-catalog@example.test");
  admin = { ...a.user, role: "ADMIN" };
  adminCookie = a.cookie;
  customer = c.user;
  customerCookie = c.cookie;
  await db.query("UPDATE users SET role='ADMIN' WHERE id=$1", [admin.id]);
});
after(async () => {
  await db?.close();
  if (root) {
    assert.ok(
      path.isAbsolute(root) &&
        path
          .resolve(root)
          .startsWith(
            path.resolve(os.tmpdir()) + path.sep + "beatstore-upload-tests-",
          ),
    );
    await rm(root, { recursive: true, force: true });
  }
});
function input(p: EditorProduct, changes: Record<string, unknown> = {}) {
  return {
    revision: p.revision,
    action: "save",
    title: p.title,
    description: p.description,
    discount: p.discount,
    price: p.price === null ? "" : (p.price / 100).toFixed(2),
    authors: p.authors,
    bpm: p.bpm === null ? "" : String(p.bpm),
    musicalKey: p.musicalKey ?? "",
    royalty: p.royalty ?? "0",
    projectRequirements: p.projectRequirements ?? "",
    usageRules: p.usageRules,
    ...changes,
  };
}
async function upload(
  p: EditorProduct,
  kind: UploadKind,
  bytes: Buffer,
  name: string,
  size = String(bytes.length),
) {
  return uploadProductFile(
    admin,
    p.id,
    kind,
    {
      stream: new Blob([new Uint8Array(bytes)]).stream(),
      size,
      name: encodeURIComponent(name),
      revision: p.revision,
    },
    db,
    root,
  );
}
const kit = () =>
  zip([
    {
      name: "USAGE.txt",
      data: Buffer.from("Commercial tracks allowed. No redistribution."),
    },
    { name: "kick.wav", data: Buffer.from("Test sound fixture") },
  ]);
async function completeKit() {
  let p = await createProduct(
    admin,
    { type: "DRUMKIT", title: "Upload test kit" },
    db,
  );
  const cover = await sharp({
    create: { width: 800, height: 400, channels: 3, background: "#4d63e8" },
  })
    .png()
    .toBuffer();
  p = await upload(p, "COVER", cover, "wide.png");
  p = await upload(
    p,
    "PREVIEW",
    await readFile(".data/demo-assets/dust/preview.mp3"),
    "preview.mp3",
  );
  p = await upload(p, "DRUMKIT", kit(), "drumkit.zip");
  return saveProduct(
    admin,
    p.id,
    input(p, {
      price: "799.95",
      discount: "12.34",
      usageRules: "Commercial tracks allowed. No redistribution.",
      action: "publish",
    }),
    db,
  );
}
function errorStatus(status: number) {
  return (error: unknown) =>
    error instanceof CatalogError && error.status === status;
}

test("drafts stay private, publishing validates completeness and stale edits do not overwrite newer data", async () => {
  let p = await createProduct(
    admin,
    { type: "BEAT", title: "Draft beat", status: "PUBLISHED", role: "ADMIN" },
    db,
  );
  assert.equal(p.status, "DRAFT");
  assert.equal(p.price, null);
  assert.ok(p.missing.includes("Полный WAV"));
  assert.equal((await getProducts("", p.id, db)).length, 0);
  await assert.rejects(
    saveProduct(admin, p.id, input(p, { action: "publish" }), db),
    errorStatus(400),
  );
  const previous = p;
  p = await saveProduct(
    admin,
    p.id,
    input(p, {
      title: "New title",
      price: "23000.17",
      royalty: "12,34",
      discount: "9,25",
      authors: ["Author", "Coauthor"],
      bpm: "135",
      musicalKey: "C minor",
      projectRequirements: "FL Studio 24, Serum",
      type: "DRUMKIT",
      status: "EXCLUSIVE_SOLD",
    }),
    db,
  );
  assert.equal(p.type, "BEAT");
  assert.equal(p.status, "DRAFT");
  assert.equal(p.price, 2300017);
  assert.equal(p.royalty, "12.34");
  await assert.rejects(
    saveProduct(admin, p.id, input(previous, { title: "Stale title" }), db),
    errorStatus(409),
  );
  assert.equal((await getEditorProduct(admin, p.id, db)).title, "New title");
  assert.equal(rubles("123,45"), 12345);
  assert.equal(decimal("0.1", "Percent"), "0.10");
  assert.throws(() => rubles("1e5"));
  assert.throws(() => decimal("100.01", "Percent"));
  assert.throws(() => rubles("0"));
  await assert.rejects(
    saveProduct(admin, p.id, input(p, { discount: "100" }), db),
    errorStatus(400),
  );
});

test("cover processing makes squares, audio duration is server-derived, and fake or unsafe files are rejected", async () => {
  let p = await createProduct(
    admin,
    { type: "BEAT", title: "Media validation beat" },
    db,
  );
  const cover = await sharp({
    create: { width: 700, height: 400, channels: 3, background: "#123456" },
  })
    .png()
    .toBuffer();
  p = await upload(p, "COVER", cover, "../../wide.png");
  const { rows } = await db.query<{
    object_key: string;
    kind: string;
    checksum: string;
  }>("SELECT object_key,kind,checksum FROM files WHERE id=ANY($1::uuid[])", [
    [p.files.COVER!.id, p.thumbnailId],
  ]);
  for (const file of rows) {
    const meta = await sharp(
      await readFile(path.join(root, file.object_key)),
    ).metadata();
    assert.equal(meta.width, file.kind === "COVER" ? 1200 : 480);
    assert.equal(meta.width, meta.height);
    assert.match(file.checksum, /^[a-f0-9]{64}$/);
    assert.ok(!file.object_key.includes(".."));
  }
  p = await upload(
    p,
    "MP3",
    await readFile(".data/demo-assets/midnight/preview.mp3"),
    "beat.mp3",
  );
  assert.ok(p.duration! >= 16 && p.duration! <= 17);
  p = await upload(
    p,
    "WAV",
    await readFile(".data/demo-assets/midnight/beat.wav"),
    "beat.wav",
  );
  p = await upload(
    p,
    "STEMS",
    zip([{ name: "track.wav", data: Buffer.from("Fixture") }]),
    "stems.zip",
  );
  p = await upload(
    p,
    "PROJECT",
    zip([{ name: "test.flp", data: Buffer.from("DEMONSTRATION FIXTURE") }]),
    "project.zip",
  );
  p = await saveProduct(
    admin,
    p.id,
    input(p, {
      price: "19999.99",
      authors: ["Main author", "Coauthor"],
      bpm: "120",
      musicalKey: "A minor",
      royalty: "10.25",
      projectRequirements: "FL Studio 24",
      action: "publish",
    }),
    db,
  );
  assert.equal(p.status, "PUBLISHED");
  const published = (await getProducts("", p.id, db))[0];
  assert.equal(published.offers.length, 4);
  const { rows: mp3Offer } = await db.query<{ file_id: string }>(
    "SELECT file_id FROM offers WHERE product_id=$1 AND kind='MP3'",
    [p.id],
  );
  assert.equal(mp3Offer[0].file_id, published.previewId);
  for (const kind of ["WAV", "STEMS", "PROJECT"] as const)
    assert.equal(await getPublicMedia(p.files[kind]!.id, db), null);
  const revision = p.revision,
    oldCover = p.files.COVER!.id;
  const before = (await readdir(root)).length;
  await assert.rejects(
    upload(p, "COVER", Buffer.from("<svg>not an image</svg>"), "fake.png"),
    errorStatus(400),
  );
  await assert.rejects(
    upload(
      p,
      "MP3",
      await readFile(".data/demo-assets/midnight/beat.wav"),
      "fake.mp3",
    ),
    errorStatus(400),
  );
  await assert.rejects(
    upload(p, "STEMS", Buffer.from("PK not a ZIP"), "fake.zip"),
    errorStatus(400),
  );
  await assert.rejects(
    upload(
      p,
      "STEMS",
      zip([{ name: "../escape.wav", data: Buffer.from("Bad") }]),
      "unsafe.zip",
    ),
    errorStatus(400),
  );
  await assert.rejects(
    upload(
      p,
      "PROJECT",
      zip([{ name: "README.txt", data: Buffer.from("No FLP") }]),
      "project.zip",
    ),
    errorStatus(400),
  );
  assert.equal((await readdir(root)).length, before);
  const unchanged = await getEditorProduct(admin, p.id, db);
  assert.equal(unchanged.revision, revision);
  assert.equal(unchanged.files.COVER!.id, oldCover);
  assert.equal(
    (await db.query("SELECT id FROM files WHERE status='PENDING'")).rows.length,
    0,
  );
});

test("replacing files and kit terms preserves purchased versions; unpublishing blocks public media and deletion protects purchases", async () => {
  let p = await completeKit();
  assert.equal(p.status, "PUBLISHED");
  assert.equal(p.missing.length, 0);
  const product = (await getProducts("", p.id, db))[0];
  assert.equal(product.offers[0].price, 70124);
  assert.ok(await getPublicMedia(p.files.PREVIEW!.id, db));
  assert.equal(await getPublicMedia(p.files.DRUMKIT!.id, db), null);
  assert.equal(await getAdminMedia(admin, p.files.DRUMKIT!.id, db), null);
  await assert.rejects(
    getAdminMedia(customer, p.files.COVER!.id, db),
    errorStatus(403),
  );
  const { rows: offers } = await db.query<{
    id: string;
    terms_version_id: string;
  }>("SELECT id,terms_version_id FROM offers WHERE product_id=$1", [p.id]);
  const oldTerms = offers[0].terms_version_id,
    oldFile = p.files.DRUMKIT!.id,
    order = randomUUID();
  await db.query(
    `INSERT INTO orders (id,user_id,product_id,offer_id,purchase_kind,status,base_price_kopecks,discount_percent,total_kopecks,snapshot,expires_at,paid_at)
    VALUES ($1,$2,$3,$4,'DRUMKIT','PAID',79995,12.34,70124,$5,now()+interval '15 minutes',now())`,
    [
      order,
      customer.id,
      p.id,
      offers[0].id,
      JSON.stringify({ termsVersionId: oldTerms }),
    ],
  );
  await db.query("INSERT INTO order_files VALUES ($1,$2)", [order, oldFile]);
  p = await upload(
    p,
    "DRUMKIT",
    zip([
      { name: "USAGE.txt", data: Buffer.from("New terms") },
      { name: "new.wav", data: Buffer.from("New sound") },
    ]),
    "new-kit.zip",
  );
  p = await saveProduct(
    admin,
    p.id,
    input(p, {
      usageRules: "Different rules for future orders.",
      price: "950.01",
    }),
    db,
  );
  assert.notEqual(p.files.DRUMKIT!.id, oldFile);
  const { rows: newOffers } = await db.query<{ terms_version_id: string }>(
    "SELECT terms_version_id FROM offers WHERE product_id=$1",
    [p.id],
  );
  assert.notEqual(newOffers[0].terms_version_id, oldTerms);
  const { rows: retained } = await db.query<{ object_key: string }>(
    "SELECT object_key FROM files WHERE id=$1",
    [oldFile],
  );
  assert.ok(
    (await readFile(path.join(root, retained[0].object_key))).length > 0,
  );
  assert.deepEqual(
    (
      await db.query<{ file_id: string }>(
        "SELECT file_id FROM order_files WHERE order_id=$1",
        [order],
      )
    ).rows,
    [{ file_id: oldFile }],
  );
  assert.equal(
    (
      await db.query<{ snapshot: { termsVersionId: string } }>(
        "SELECT snapshot FROM orders WHERE id=$1",
        [order],
      )
    ).rows[0].snapshot.termsVersionId,
    oldTerms,
  );
  await assert.rejects(
    deleteProduct(
      admin,
      p.id,
      { revision: p.revision, confirmation: p.title },
      db,
    ),
    errorStatus(409),
  );
  p = await saveProduct(admin, p.id, input(p, { action: "unpublish" }), db);
  assert.equal(p.status, "UNPUBLISHED");
  assert.equal((await getProducts("", p.id, db)).length, 0);
  assert.equal(await getPublicMedia(p.files.PREVIEW!.id, db), null);
  assert.ok(await getAdminMedia(admin, p.files.PREVIEW!.id, db));
});

test("deletion requires the title and preserves cancelled orders and prior free acceptance snapshots", async () => {
  const p = await createProduct(
    admin,
    { type: "BEAT", title: "Delete test" },
    db,
  );
  const { rows: offers } = await db.query<{ id: string }>(
    "SELECT id FROM offers WHERE product_id=$1 AND kind='MP3'",
    [p.id],
  );
  const { rows: terms } = await db.query<{ id: string }>(
    "SELECT id FROM terms_versions WHERE kind='FREE_MP3'",
  );
  await db.query(
    `INSERT INTO free_acceptances (user_id,product_id,product_snapshot,terms_version_id) VALUES ($1,$2,$3,$4)`,
    [
      customer.id,
      p.id,
      JSON.stringify({ id: p.id, title: p.title }),
      terms[0].id,
    ],
  );
  const order = randomUUID();
  await db.query(
    `INSERT INTO orders (id,user_id,product_id,offer_id,purchase_kind,status,base_price_kopecks,discount_percent,total_kopecks,snapshot,expires_at) VALUES ($1,$2,$3,$4,'MP3','CANCELLED',100000,0,100000,$5,now())`,
    [
      order,
      customer.id,
      p.id,
      offers[0].id,
      JSON.stringify({ id: p.id, title: p.title }),
    ],
  );
  await assert.rejects(
    deleteProduct(
      admin,
      p.id,
      { revision: p.revision, confirmation: "Wrong title" },
      db,
    ),
    errorStatus(400),
  );
  await deleteProduct(
    admin,
    p.id,
    { revision: p.revision, confirmation: p.title },
    db,
  );
  await assert.rejects(getEditorProduct(admin, p.id, db), errorStatus(404));
  const { rows } = await db.query<{
    product_id: null;
    offer_id: null;
    snapshot: { id: string };
  }>("SELECT product_id,offer_id,snapshot FROM orders WHERE id=$1", [order]);
  assert.equal(rows[0].product_id, null);
  assert.equal(rows[0].offer_id, null);
  assert.equal(rows[0].snapshot.id, p.id);
  assert.equal(
    (
      await db.query<{ product_id: null }>(
        "SELECT product_id FROM free_acceptances WHERE user_id=$1",
        [customer.id],
      )
    ).rows[0].product_id,
    null,
  );
});

test("pending payments and exclusive sales block changes; a sold exclusive cannot be republished", async () => {
  const p = await getEditorProduct(
    admin,
    "10000000-0000-4000-8000-000000000002",
    db,
  );
  const { rows: offers } = await db.query<{ id: string; kind: string }>(
    "SELECT id,kind FROM offers WHERE product_id=$1",
    [p.id],
  );
  const waiting = randomUUID();
  await db.query(
    `INSERT INTO orders (id,user_id,product_id,offer_id,purchase_kind,base_price_kopecks,discount_percent,total_kopecks,snapshot,expires_at) VALUES ($1,$2,$3,$4,'WAV',200000,0,200000,'{}',now()+interval '15 minutes')`,
    [waiting, customer.id, p.id, offers.find((o) => o.kind === "WAV")!.id],
  );
  await assert.rejects(
    saveProduct(admin, p.id, input(p, { title: "Cannot change" }), db),
    errorStatus(409),
  );
  await assert.rejects(
    upload(
      p,
      "WAV",
      await readFile(".data/demo-assets/midnight/beat.wav"),
      "beat.wav",
    ),
    errorStatus(409),
  );
  await db.query("UPDATE orders SET status='CANCELLED' WHERE id=$1", [waiting]);
  const sale = randomUUID();
  await db.query(
    `INSERT INTO orders (id,user_id,product_id,offer_id,purchase_kind,status,base_price_kopecks,discount_percent,total_kopecks,snapshot,expires_at,paid_at) VALUES ($1,$2,$3,$4,'EXCLUSIVE','PAID',2000000,0,2000000,'{}',now(),now())`,
    [sale, customer.id, p.id, offers.find((o) => o.kind === "EXCLUSIVE")!.id],
  );
  await assert.rejects(
    saveProduct(admin, p.id, input(p, { action: "publish" }), db),
    errorStatus(409),
  );
  await db.query(
    "UPDATE products SET status='EXCLUSIVE_SOLD',exclusive_order_id=$2 WHERE id=$1",
    [p.id, sale],
  );
  await assert.rejects(
    db.query("UPDATE products SET status='PUBLISHED' WHERE id=$1", [p.id]),
    /cannot be reopened/,
  );
});

test("upload reservations enforce total quota and declared size, and failures leave no pending records or temporary files", async () => {
  const p = await createProduct(
      admin,
      { type: "DRUMKIT", title: "Quota test" },
      db,
    ),
    fake = randomUUID();
  const { rows } = await db.query<{ used: string }>(
    "SELECT coalesce(sum(size_bytes),0)::text AS used FROM files WHERE status IN ('READY','PENDING')",
  );
  await db.query(
    `INSERT INTO files (id,bucket,object_key,original_name,content_type,size_bytes,kind,status) VALUES ($1,'local-upload','quota-test','quota-test','application/zip',$2,'DRUMKIT','PENDING')`,
    [fake, STORAGE_LIMIT - Number(rows[0].used)],
  );
  await assert.rejects(
    upload(p, "DRUMKIT", kit(), "kit.zip"),
    errorStatus(413),
  );
  await db.query("DELETE FROM files WHERE id=$1", [fake]);
  const before = (await readdir(root)).length;
  await assert.rejects(
    upload(p, "DRUMKIT", kit(), "kit.zip", String(501 * 1024 * 1024)),
    errorStatus(413),
  );
  await assert.rejects(
    upload(p, "DRUMKIT", kit(), "kit.zip", String(kit().length - 1)),
    errorStatus(413),
  );
  await assert.rejects(
    upload(p, "DRUMKIT", kit(), "kit.zip", String(kit().length + 1)),
    errorStatus(400),
  );
  assert.equal((await readdir(root)).length, before);
  assert.equal(
    (await db.query("SELECT id FROM files WHERE status='PENDING'")).rows.length,
    0,
  );
});

test("admin API validates sessions, roles, origin and bounded JSON bodies before writing", async () => {
  const request = (
    method: string,
    cookie: string,
    body: unknown,
    requestOrigin = origin,
  ) =>
    new Request(`${origin}/api/admin/products`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: requestOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await handleCatalogRequest(
        db,
        auth,
        request("POST", "beatstore.session_token=forged", {
          title: "Bad",
          type: "BEAT",
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleCatalogRequest(
        db,
        auth,
        request("POST", customerCookie, {
          title: "Bad",
          type: "BEAT",
          role: "ADMIN",
        }),
      )
    ).status,
    403,
  );
  await assert.rejects(
    createProduct(
      { ...customer, role: "ADMIN" },
      { type: "BEAT", title: "Forged role" },
      db,
    ),
    errorStatus(403),
  );
  assert.equal(
    (
      await handleCatalogRequest(
        db,
        auth,
        request(
          "POST",
          adminCookie,
          { title: "Cross site", type: "BEAT" },
          "https://attacker.invalid",
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleCatalogRequest(
        db,
        auth,
        request("POST", adminCookie, {
          title: "x".repeat(50000),
          type: "BEAT",
        }),
      )
    ).status,
    413,
  );
  const response = await handleCatalogRequest(
    db,
    auth,
    request("POST", adminCookie, {
      title: "API-created kit",
      type: "DRUMKIT",
      status: "PUBLISHED",
    }),
  );
  assert.equal(response.status, 201);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const p = await response.json();
  assert.equal(p.status, "DRAFT");
  const mutation = new Request(`${origin}/api/admin/products/${p.id}`, {
    method: "DELETE",
    headers: {
      Origin: origin,
      Cookie: customerCookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ revision: p.revision, confirmation: p.title }),
  });
  assert.equal(
    (await handleCatalogRequest(db, auth, mutation, p.id)).status,
    403,
  );
  await db.query("UPDATE users SET role='CUSTOMER' WHERE id=$1", [admin.id]);
  assert.equal(
    (
      await handleCatalogRequest(
        db,
        auth,
        request("POST", adminCookie, {
          title: "Old role cookie",
          type: "BEAT",
        }),
      )
    ).status,
    403,
  );
  await db.query("UPDATE users SET role='ADMIN' WHERE id=$1", [admin.id]);
});

test("an interrupted or stale upload cleans its reservation without overwriting the product", async () => {
  let p = await createProduct(
    admin,
    { type: "DRUMKIT", title: "Interrupted upload" },
    db,
  );
  const bytes = kit(),
    before = (await readdir(root)).length;
  const interrupted = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new DOMException("Test interruption", "AbortError"));
    },
  });
  await assert.rejects(
    uploadProductFile(
      admin,
      p.id,
      "DRUMKIT",
      {
        stream: interrupted,
        size: String(bytes.length),
        name: "kit.zip",
        revision: p.revision,
      },
      db,
      root,
    ),
    errorStatus(400),
  );
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const result = uploadProductFile(
    admin,
    p.id,
    "DRUMKIT",
    {
      stream,
      size: String(bytes.length),
      name: "kit.zip",
      revision: p.revision,
    },
    db,
    root,
  ).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
  const deadline = Date.now() + 5000;
  while (
    !(await db.query("SELECT id FROM files WHERE status='PENDING'")).rows.length
  ) {
    assert.ok(Date.now() < deadline, "Upload reservation was not created");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  p = await saveProduct(
    admin,
    p.id,
    input(p, { title: "Saved while uploading" }),
    db,
  );
  controller!.enqueue(new Uint8Array(bytes));
  controller!.close();
  assert.ok(errorStatus(409)((await result).error));
  const current = await getEditorProduct(admin, p.id, db);
  assert.equal(current.title, p.title);
  assert.equal(current.revision, p.revision);
  assert.equal(current.files.DRUMKIT, undefined);
  assert.equal((await readdir(root)).length, before);
  assert.equal(
    (await db.query("SELECT id FROM files WHERE status='PENDING'")).rows.length,
    0,
  );
});

test("media streams preserve range, HEAD and conditional request semantics", async () => {
  const p = (await getProducts("Midnight", undefined, db))[0];
  const file = (await getPublicMedia(p.previewId, db))!;
  const response = await mediaResponse(
    new Request(`${origin}/media/${file.id}`, {
      headers: { Range: "bytes=20-39" },
    }),
    file,
  );
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 20);
  const head = await mediaResponse(
    new Request(`${origin}/media/${file.id}`, {
      method: "HEAD",
      headers: { Range: "bytes=20-39" },
    }),
    file,
    true,
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get("content-length"), String(file.size_bytes));
  const cached = await mediaResponse(
    new Request(`${origin}/media/${file.id}`, {
      headers: { "If-None-Match": `"${file.checksum}"` },
    }),
    file,
  );
  assert.equal(cached.status, 304);
  const invalid = await mediaResponse(
    new Request(`${origin}/media/${file.id}`, {
      headers: { Range: "bytes=999999999-" },
    }),
    file,
  );
  assert.equal(invalid.status, 416);
});
