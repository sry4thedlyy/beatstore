import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { before, after, test } from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  createEmbeddedDatabase,
  type Database,
} from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "../scripts/seed";
import { createAuth, type ShopAuth } from "../src/server/auth";
import { handleAuthRequest } from "../src/server/auth/handler";
import type { CurrentUser } from "../src/server/auth/session";
import { createDemoProvider } from "../src/server/payments/provider";
import {
  createOrder,
  getCheckoutQuote,
  simulateOrder,
  getOrder,
} from "../src/server/checkout/service";
import { ensureLicenseDocument } from "../src/server/documents/service";
import {
  getDeliveryView,
  getFreeDownload,
  issueFreeDownload,
  issuePurchaseDownload,
  resolveDownload,
} from "../src/server/delivery/service";
import {
  handleDeliveryRequest,
  handleDownloadRequest,
} from "../src/server/delivery/handler";
import { verifyDownload } from "../src/server/delivery/token";
import { getPublicMedia, localMediaPath } from "../src/server/media";
import { STORAGE_LIMIT } from "../src/domain/catalog-editor";
import { safeReturnTo } from "../src/domain/auth";

let db: Database, auth: ShopAuth, root: string;
let buyer: { user: CurrentUser; cookie: string },
  other: typeof buyer,
  admin: typeof buyer;
const origin = "http://127.0.0.1:3000",
  secret = "An-isolated-delivery-test-secret-of-48-characters";
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "beatstore-delivery-tests-"));
  db = await createEmbeddedDatabase();
  await migrate(db);
  await seedDemo(db);
  auth = createAuth(db, { baseURL: origin, secret });
  async function register(name: string) {
    const r = await handleAuthRequest(
      auth,
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `${name}@example.test`,
          name: `Тест ${name}`,
          password: "Delivery-account-password-2026",
        }),
      }),
    );
    assert.equal(r.status, 200);
    const v = await r.json();
    return {
      user: {
        id: v.user.id,
        email: v.user.email,
        name: v.user.name,
        role: "CUSTOMER" as const,
      },
      cookie: r.headers.get("set-cookie")!.split(";")[0],
    };
  }
  buyer = await register("buyer-delivery");
  other = await register("other-delivery");
  admin = await register("admin-delivery");
  await db.query("UPDATE users SET role='ADMIN' WHERE id=$1", [admin.user.id]);
  admin.user.role = "ADMIN";
});
after(async () => {
  await db?.close();
  if (root) {
    assert.ok(
      path
        .resolve(root)
        .startsWith(
          path.resolve(tmpdir()) + path.sep + "beatstore-delivery-tests-",
        ),
    );
    await rm(root, { recursive: true, force: true });
  }
});
function post(
  url: string,
  value: unknown,
  cookie = buyer.cookie,
  site = origin,
) {
  return new Request(origin + url, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: site,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
}
function options() {
  return {
    directory: root,
    pathForFile: (f: Parameters<typeof localMediaPath>[0]) =>
      f.bucket === "local-document"
        ? path.join(root, f.object_key)
        : localMediaPath(f),
  };
}
function token(url: string) {
  return new URL(url, origin).searchParams.get("token")!;
}
async function product(type = "BEAT") {
  const id = randomUUID(),
    source =
      type === "BEAT"
        ? "10000000-0000-4000-8000-000000000001"
        : "10000000-0000-4000-8000-000000000003";
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO products(id,type,title,description,status,discount_percent,cover_file_id,thumbnail_file_id,preview_file_id,duration_seconds,authors,bpm,musical_key,royalty_percent,project_requirements)
      SELECT $1,type,title,description,status,discount_percent,cover_file_id,thumbnail_file_id,preview_file_id,duration_seconds,authors,bpm,musical_key,royalty_percent,project_requirements FROM products WHERE id=$2`,
      [id, source],
    );
    await tx.query(
      `INSERT INTO offers(product_id,kind,base_price_kopecks,file_id,terms_version_id) SELECT $1,kind,base_price_kopecks,file_id,terms_version_id FROM offers WHERE product_id=$2`,
      [id, source],
    );
  });
  return id;
}
async function order(id: string, kind = "WAV", paid = true) {
  const p = createDemoProvider(db),
    q = await getCheckoutQuote(buyer.user, id, kind, db);
  const o = await createOrder(
    buyer.user,
    {
      productId: id,
      kind,
      revision: q.revision,
      requestKey: randomUUID(),
      accepted: true,
    },
    db,
    p,
    origin,
  );
  return paid ? simulateOrder(buyer.user, o.id, "succeeded", db, p, origin) : o;
}
async function download(
  url: string,
  cookie = buyer.cookie,
  headers: Record<string, string> = {},
  head = false,
) {
  return handleDownloadRequest(
    db,
    auth,
    new Request(origin + url, { headers: { Cookie: cookie, ...headers } }),
    head,
    options(),
  );
}

test("anonymous, foreign, cross-origin and oversized requests cannot obtain private downloads", async () => {
  const id = await product(),
    o = await order(id),
    url = `/api/orders/${o.id}/delivery`;
  assert.equal(
    (
      await handleDeliveryRequest(
        db,
        auth,
        post(url, { action: "file" }, ""),
        o.id,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handleDeliveryRequest(
        db,
        auth,
        post(url, { action: "file" }, other.cookie),
        o.id,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await handleDeliveryRequest(
        db,
        auth,
        post(url, { action: "file" }, buyer.cookie, "https://other.invalid"),
        o.id,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleDeliveryRequest(
        db,
        auth,
        post(url, { action: "file", extra: "x".repeat(9000) }),
        o.id,
      )
    ).status,
    413,
  );
  const link = await issuePurchaseDownload(buyer.user, o.id, false, db, secret);
  assert.equal((await download(link.url, "")).status, 401);
  assert.equal((await download(link.url, other.cookie)).status, 404);
  assert.equal((await download(link.url + "broken")).status, 404);
  assert.throws(() =>
    verifyDownload(token(link.url), secret, buyer.user.id, Date.now() + 301000),
  );
  assert.equal(
    (
      await handleDeliveryRequest(
        db,
        auth,
        post(url, { action: "file" }, admin.cookie),
        o.id,
      )
    ).status,
    404,
  );
});

test("paid versions stream as attachments with HEAD, ranges and validation; pending, cancelled and refunded orders cannot deliver files", async () => {
  const id = await product();
  const pending = await order(id, "WAV", false);
  await assert.rejects(
    issuePurchaseDownload(buyer.user, pending.id, false, db, secret),
    /недоступно/,
  );
  await simulateOrder(
    buyer.user,
    pending.id,
    "canceled",
    db,
    createDemoProvider(db),
    origin,
  );
  await assert.rejects(
    issuePurchaseDownload(buyer.user, pending.id, false, db, secret),
    /недоступно/,
  );
  const paid = await order(id),
    link = await issuePurchaseDownload(buyer.user, paid.id, false, db, secret);
  const range = await download(link.url, buyer.cookie, { Range: "bytes=0-15" });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 16);
  assert.ok(
    range.headers.get("content-disposition")?.startsWith("attachment;"),
  );
  assert.equal(range.headers.get("cache-control"), "private, no-store");
  assert.equal(range.headers.get("referrer-policy"), "no-referrer");
  const head = await download(link.url, buyer.cookie, {}, true);
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const etag = head.headers.get("etag")!;
  assert.equal(
    (await download(link.url, buyer.cookie, { "If-None-Match": etag })).status,
    304,
  );
  assert.equal(
    (await download(link.url, buyer.cookie, { Range: "bytes=999999999-" }))
      .status,
    416,
  );
  const full = await download(link.url, buyer.cookie, {
    Range: "bytes=0-15",
    "If-Range": '"old"',
  });
  assert.equal(full.status, 200);
  await full.body?.cancel();
  await db.query(
    "UPDATE orders SET status='REFUNDED',refunded_at=now() WHERE id=$1",
    [paid.id],
  );
  assert.equal((await download(link.url)).status, 409);
});

test("documents use frozen purchase data, remain immutable after editing or unpublishing and allow administrator document access only", async () => {
  const id = await product(),
    o = await order(id);
  await ensureLicenseDocument(o.id, db, options());
  const view = await getDeliveryView(buyer.user, o.id, db);
  assert.equal(view.document?.status, "READY");
  const link = await issuePurchaseDownload(buyer.user, o.id, true, db, secret),
    grant = verifyDownload(token(link.url), secret, buyer.user.id);
  const f = await resolveDownload(buyer.user, grant, db),
    bytes = await readFile(path.join(root, f.object_key));
  const pdf = await PDFDocument.load(bytes);
  assert.match(pdf.getTitle()!, /Демонстрационная лицензия WAV/);
  assert.ok(pdf.getPageCount() >= 1);
  assert.equal(await getPublicMedia(f.id, db), null);
  const oldFile = (await getDeliveryView(buyer.user, o.id, db)).file!.id;
  const { rows: replacement } = await db.query<{ file_id: string }>(
    "SELECT file_id FROM offers WHERE product_id='10000000-0000-4000-8000-000000000002' AND kind='WAV'",
  );
  await db.query(
    "UPDATE products SET title='Новое название',authors=ARRAY['Другой автор'],status='UNPUBLISHED' WHERE id=$1",
    [id],
  );
  await db.query(
    "UPDATE offers SET file_id=$2 WHERE product_id=$1 AND kind='WAV'",
    [id, replacement[0].file_id],
  );
  await ensureLicenseDocument(o.id, db, options(), true);
  assert.equal((await getDeliveryView(buyer.user, o.id, db)).file!.id, oldFile);
  assert.deepEqual(await readFile(path.join(root, f.object_key)), bytes);
  await assert.rejects(
    db.query("UPDATE documents SET status='FAILED' WHERE order_id=$1", [o.id]),
    /immutable/,
  );
  const adminResponse = await handleDeliveryRequest(
    db,
    auth,
    post(`/api/orders/${o.id}/delivery`, { action: "document" }, admin.cookie),
    o.id,
    false,
    options(),
  );
  assert.equal(adminResponse.status, 200);
  const adminLink = await adminResponse.json();
  const r = await download(adminLink.url, admin.cookie);
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, bytes.length);
  assert.equal((await download(link.url, admin.cookie)).status, 404);
  assert.equal(
    (
      await handleDeliveryRequest(
        db,
        auth,
        post(
          `/api/orders/${o.id}/delivery`,
          { action: "document" },
          other.cookie,
        ),
        o.id,
        false,
        options(),
      )
    ).status,
    404,
  );
});

test("PDF failure and quota exhaustion do not undo payment; retry keeps the document ID and does not duplicate files", async () => {
  const id = await product(),
    o = await order(id);
  await ensureLicenseDocument(o.id, db, {
    directory: root,
    render: async () => {
      throw new Error("Injected failure");
    },
  });
  let view = await getDeliveryView(buyer.user, o.id, db);
  assert.equal(view.document?.status, "FAILED");
  assert.ok(view.file);
  const docId = view.document!.id;
  const { rows: used } = await db.query<{ used: string }>(
    "SELECT sum(size_bytes)::text used FROM files WHERE status IN ('PENDING','READY')",
  );
  const filler = randomUUID();
  await db.query(
    "INSERT INTO files(id,bucket,object_key,original_name,content_type,size_bytes,kind,status) VALUES($1,'test','quota','quota','application/pdf',$2,'DOCUMENT','PENDING')",
    [filler, STORAGE_LIMIT - Number(used[0].used)],
  );
  await ensureLicenseDocument(o.id, db, options(), true);
  assert.equal(
    (await getDeliveryView(buyer.user, o.id, db)).document?.status,
    "FAILED",
  );
  assert.equal((await getOrder(buyer.user, o.id, db)).status, "PAID");
  await db.query("DELETE FROM files WHERE id=$1", [filler]);
  await ensureLicenseDocument(o.id, db, options(), true);
  view = await getDeliveryView(buyer.user, o.id, db);
  assert.equal(view.document?.status, "READY");
  assert.equal(view.document?.id, docId);
  const before = await readdir(root);
  await ensureLicenseDocument(o.id, db, options(), true);
  assert.deepEqual(await readdir(root), before);
});

test("free MP3 requires acceptance per version, repeated requests reuse it, and old links stop after exclusive sale", async () => {
  const id = await product(),
    q = await getFreeDownload(buyer.user, id, db),
    input = { revision: q.revision, termsId: q.termsId };
  assert.equal(q.accepted, false);
  await assert.rejects(
    issueFreeDownload(buyer.user, id, input, db, secret),
    /Подтверди/,
  );
  await assert.rejects(
    issueFreeDownload(
      buyer.user,
      id,
      { ...input, accepted: true, revision: 0 },
      db,
      secret,
    ),
    /изменились/,
  );
  const link = await issueFreeDownload(
    buyer.user,
    id,
    { ...input, accepted: true },
    db,
    secret,
  );
  await issueFreeDownload(buyer.user, id, input, db, secret);
  assert.equal((await getFreeDownload(buyer.user, id, db)).accepted, true);
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::integer n FROM free_acceptances WHERE product_id=$1 AND user_id=$2",
    [id, buyer.user.id],
  );
  assert.equal(rows[0].n, 1);
  const r = await download(link.url, buyer.cookie, { Range: "bytes=0-3" });
  assert.equal(r.status, 206);
  await r.arrayBuffer();
  const paid = await order(id);
  await ensureLicenseDocument(paid.id, db, options());
  const paidLink = await issuePurchaseDownload(
    buyer.user,
    paid.id,
    false,
    db,
    secret,
  );
  const ex = await order(id, "EXCLUSIVE");
  await ensureLicenseDocument(ex.id, db, options());
  assert.equal((await download(link.url)).status, 404);
  await assert.rejects(getFreeDownload(buyer.user, id, db), /недоступно/);
  const remains = await download(paidLink.url, buyer.cookie, {
    Range: "bytes=0-3",
  });
  assert.equal(remains.status, 206);
  await remains.arrayBuffer();
  assert.equal(
    safeReturnTo(`/products/${id}/free?token=anything`),
    `/products/${id}/free`,
  );
});

test("new free terms require fresh acceptance and revoke earlier links; drumkits get ZIP without a separate document", async () => {
  const id = await product(),
    q = await getFreeDownload(buyer.user, id, db);
  const old = await issueFreeDownload(
    buyer.user,
    id,
    { revision: q.revision, termsId: q.termsId, accepted: true },
    db,
    secret,
  );
  await db.query(
    "INSERT INTO terms_versions(kind,version,body,created_at) VALUES('FREE_MP3','delivery-v2','Новая версия бесплатных условий',now()+interval '1 second')",
  );
  const newQuote = await getFreeDownload(buyer.user, id, db);
  assert.equal(newQuote.accepted, false);
  assert.equal((await download(old.url)).status, 404);
  await issueFreeDownload(
    buyer.user,
    id,
    { revision: newQuote.revision, termsId: newQuote.termsId, accepted: true },
    db,
    secret,
  );
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::integer n FROM free_acceptances WHERE product_id=$1 AND user_id=$2",
    [id, buyer.user.id],
  );
  assert.equal(rows[0].n, 2);
  const kit = await order(await product("DRUMKIT"), "DRUMKIT");
  await ensureLicenseDocument(kit.id, db, options());
  assert.equal((await getDeliveryView(buyer.user, kit.id, db)).document, null);
  const link = await issuePurchaseDownload(
      buyer.user,
      kit.id,
      false,
      db,
      secret,
    ),
    r = await download(link.url, buyer.cookie, { Range: "bytes=0-1" });
  assert.equal(r.status, 206);
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), "PK");
  await assert.rejects(
    issuePurchaseDownload(buyer.user, kit.id, true, db, secret),
    /не готов/,
  );
});

test("MP3 and STEMS deliver only their purchased format; review flags revoke existing file and document links", async () => {
  for (const kind of ["MP3", "STEMS"]) {
    const o = await order(await product(), kind);
    await ensureLicenseDocument(o.id, db, options());
    const f = await issuePurchaseDownload(buyer.user, o.id, false, db, secret),
      d = await issuePurchaseDownload(buyer.user, o.id, true, db, secret);
    const file = await resolveDownload(
      buyer.user,
      verifyDownload(token(f.url), secret, buyer.user.id),
      db,
    );
    assert.equal(
      file.content_type,
      kind === "MP3" ? "audio/mpeg" : "application/zip",
    );
    assert.equal(
      (await getDeliveryView(buyer.user, o.id, db)).document?.status,
      "READY",
    );
    await db.query("UPDATE payments SET needs_review=true WHERE order_id=$1", [
      o.id,
    ]);
    assert.equal((await download(f.url)).status, 409);
    assert.equal((await download(d.url)).status, 409);
    assert.equal((await getDeliveryView(buyer.user, o.id, db)).allowed, false);
  }
});
