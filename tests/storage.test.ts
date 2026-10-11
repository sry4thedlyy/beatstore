import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { testStorage } from "./support/s3";
import { storageDriver, yandexConfig } from "../src/server/storage/config";
import { StorageError } from "../src/server/storage/yandex";
import { checkStorage } from "../src/server/storage/check";
import { importLocalFiles } from "../src/server/storage/import";
import {
  createEmbeddedDatabase,
  type Database,
} from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "../scripts/seed";
import { zip } from "../scripts/generate-demo-assets";
import {
  getPublicMedia,
  localMediaPath,
  mediaResponse,
  type MediaFile,
} from "../src/server/media";
import { uploadProductFile } from "../src/server/catalog/uploads";
import { createProduct, getEditorProduct } from "../src/server/catalog/admin";
import { createDemoProvider } from "../src/server/payments/provider";
import {
  createOrder,
  getCheckoutQuote,
  simulateOrder,
} from "../src/server/checkout/service";
import {
  issuePurchaseDownload,
  resolveDownload,
} from "../src/server/delivery/service";
import { verifyDownload } from "../src/server/delivery/token";
import { ensureLicenseDocument } from "../src/server/documents/service";
import {
  CatalogError,
  type EditorProduct,
  type UploadKind,
} from "../src/domain/catalog-editor";
import type { CurrentUser } from "../src/server/auth/session";

let db: Database,
  storage: Awaited<ReturnType<typeof testStorage>>,
  root: string;
const admin: CurrentUser = {
  id: randomUUID(),
  name: "Storage admin",
  email: "storage-admin@example.test",
  role: "ADMIN",
};
const buyer: CurrentUser = {
  id: randomUUID(),
  name: "Storage buyer",
  email: "storage-buyer@example.test",
  role: "CUSTOMER",
};
const beat = "10000000-0000-4000-8000-000000000001",
  otherBeat = "10000000-0000-4000-8000-000000000002";
const secret = "An-isolated-storage-download-secret-of-48-characters",
  origin = "http://127.0.0.1:3000";
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "beatstore-storage-tests-"));
  storage = await testStorage();
  db = await createEmbeddedDatabase();
  await migrate(db);
  await seedDemo(db);
  for (const user of [admin, buyer])
    await db.query(
      "INSERT INTO users(id,email,artist_name,role) VALUES($1,$2,$3,$4)",
      [user.id, user.email, user.name, user.role],
    );
});
after(async () => {
  await db?.close();
  await storage?.close();
  if (root) {
    assert.ok(
      path
        .resolve(root)
        .startsWith(
          path.resolve(tmpdir()) + path.sep + "beatstore-storage-tests-",
        ),
    );
    await rm(root, { recursive: true, force: true });
  }
});
async function upload(
  p: EditorProduct,
  kind: UploadKind,
  bytes: Buffer,
  name: string,
) {
  return uploadProductFile(
    admin,
    p.id,
    kind,
    {
      stream: new Blob([new Uint8Array(bytes)]).stream(),
      size: String(bytes.length),
      name: encodeURIComponent(name),
      revision: p.revision,
    },
    db,
    root,
    storage.cloud,
  );
}
async function paid(productId = beat, kind = "WAV") {
  const provider = createDemoProvider(db),
    q = await getCheckoutQuote(buyer, productId, kind, db);
  const order = await createOrder(
    buyer,
    {
      productId,
      kind,
      revision: q.revision,
      accepted: true,
      requestKey: randomUUID(),
    },
    db,
    provider,
    origin,
  );
  return simulateOrder(buyer, order.id, "succeeded", db, provider, origin);
}
async function file(id: string) {
  return (await db.query<MediaFile>("SELECT * FROM files WHERE id=$1", [id]))
    .rows[0];
}
const checksum = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

test("configuration requires explicit Yandex credentials and a bounded bucket prefix", () => {
  assert.equal(storageDriver({}), "local");
  assert.throws(() => storageDriver({ STORAGE_DRIVER: "unknown" }));
  const env = {
    YC_STORAGE_BUCKET: "beatstore-test",
    YC_STORAGE_ACCESS_KEY_ID: "TEST-ACCESS",
    YC_STORAGE_SECRET_ACCESS_KEY: "TEST-SECRET",
  };
  assert.equal(yandexConfig(env).prefix, "beatstore/");
  for (const bucket of ["local-demo", "../private", "192.168.1.1", "a..b"])
    assert.throws(() => yandexConfig({ ...env, YC_STORAGE_BUCKET: bucket }));
  for (const prefix of ["../secret", "/root", "a//b", "a?b"])
    assert.throws(() => yandexConfig({ ...env, YC_STORAGE_PREFIX: prefix }));
  assert.throws(() =>
    yandexConfig({ ...env, YC_STORAGE_SECRET_ACCESS_KEY: "" }),
  );
});
test("real SDK signs HTTP operations, prevents overwrite, streams ranges and rejects changed objects", async () => {
  const bytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz"),
    ref = storage.cloud.reference("uploads", `${randomUUID()}.wav`),
    operation = randomUUID();
  await storage.cloud.putBytes(
    ref,
    bytes,
    "audio/wav",
    checksum(bytes),
    operation,
  );
  const f: MediaFile = {
    ...ref,
    id: randomUUID(),
    size_bytes: String(bytes.length),
    checksum: checksum(bytes),
    content_type: "audio/wav",
  };
  const request = (headers: Record<string, string> = {}) =>
    new Request(origin + "/media/test", { headers });
  const range = await mediaResponse(
    request({ Range: "bytes=2-7" }),
    f,
    false,
    true,
    "бит.wav",
    undefined,
    storage.cloud,
  );
  assert.equal(range.status, 206);
  assert.deepEqual(
    Buffer.from(await range.arrayBuffer()),
    bytes.subarray(2, 8),
  );
  assert.match(range.headers.get("content-disposition")!, /filename\*=UTF-8/);
  assert.equal(range.headers.get("cache-control"), "private, no-store");
  const head = await mediaResponse(
    request(),
    f,
    true,
    true,
    undefined,
    undefined,
    storage.cloud,
  );
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal(await head.text(), "");
  assert.equal(
    (
      await mediaResponse(
        request({ "If-None-Match": `"${f.checksum}"` }),
        f,
        false,
        true,
        undefined,
        undefined,
        storage.cloud,
      )
    ).status,
    304,
  );
  assert.equal(
    (
      await mediaResponse(
        request({ Range: "bytes=999-" }),
        f,
        false,
        true,
        undefined,
        undefined,
        storage.cloud,
      )
    ).status,
    416,
  );
  const full = await mediaResponse(
    request({ Range: "bytes=2-7", "If-Range": "changed" }),
    f,
    false,
    true,
    undefined,
    undefined,
    storage.cloud,
  );
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  assert.ok(
    storage.requests.some((r) =>
      r.headers.authorization?.includes("/ru-central1/s3/aws4_request"),
    ),
  );
  const count = storage.requests.length;
  await assert.rejects(
    storage.cloud.head({ ...ref, bucket: "another-bucket" }),
    StorageError,
  );
  await assert.rejects(
    storage.cloud.head({ ...ref, object_key: "beatstore/../secret.txt" }),
    StorageError,
  );
  assert.equal(storage.requests.length, count);
  await assert.rejects(
    storage.cloud.putBytes(
      ref,
      bytes,
      "audio/wav",
      checksum(bytes),
      randomUUID(),
    ),
    StorageError,
  );
  assert.equal(
    await storage.cloud.removeOwned(ref, "different-operation"),
    true,
  );
  assert.ok(storage.objects.has(ref.object_key));
  storage.faults.ignoreRange = true;
  assert.equal(
    (
      await mediaResponse(
        request({ Range: "bytes=2-7" }),
        f,
        false,
        true,
        undefined,
        undefined,
        storage.cloud,
      )
    ).status,
    503,
  );
  storage.faults.ignoreRange = false;
  storage.faults.head = true;
  assert.equal(
    (
      await mediaResponse(
        request(),
        f,
        false,
        true,
        undefined,
        undefined,
        storage.cloud,
      )
    ).status,
    503,
  );
  storage.faults.head = false;
  assert.equal(
    (
      await mediaResponse(
        request(),
        { ...f, checksum: "0".repeat(64) },
        false,
        true,
        undefined,
        undefined,
        storage.cloud,
      )
    ).status,
    503,
  );
  assert.equal(await storage.cloud.removeOwned(ref, operation), true);
  assert.equal(
    (
      await mediaResponse(
        request(),
        f,
        false,
        true,
        undefined,
        undefined,
        storage.cloud,
      )
    ).status,
    404,
  );
});
test("validated product uploads, private purchases and immutable PDFs use cloud objects without retaining staging files", async () => {
  let p = await getEditorProduct(admin, beat, db);
  const cover = await sharp({
    create: { width: 640, height: 400, channels: 3, background: "#4455cc" },
  })
    .png()
    .toBuffer();
  p = await upload(p, "COVER", cover, "cover.png");
  p = await upload(
    p,
    "MP3",
    await readFile(".data/demo-assets/midnight/preview.mp3"),
    "beat.mp3",
  );
  const wav = await readFile(".data/demo-assets/midnight/beat.wav");
  p = await upload(p, "WAV", wav, "beat.wav");
  p = await upload(
    p,
    "STEMS",
    zip([{ name: "track.wav", data: Buffer.from("Test track") }]),
    "stems.zip",
  );
  p = await upload(
    p,
    "PROJECT",
    zip([{ name: "project.flp", data: Buffer.from("Test FLP fixture") }]),
    "project.zip",
  );
  assert.deepEqual(await readdir(root), []);
  for (const id of [
    p.files.COVER!.id,
    p.thumbnailId!,
    p.files.MP3!.id,
    p.files.WAV!.id,
    p.files.STEMS!.id,
    p.files.PROJECT!.id,
  ]) {
    const f = await file(id);
    assert.equal(f.bucket, "beatstore-test");
    assert.ok(storage.objects.has(f.object_key));
    if (f.content_type === "image/jpeg") {
      const meta = await sharp(
        storage.objects.get(f.object_key)!.bytes,
      ).metadata();
      assert.equal(meta.width, meta.height);
    }
  }
  assert.equal(await getPublicMedia(p.files.WAV!.id, db), null);
  assert.ok(await getPublicMedia(p.files.COVER!.id, db));
  const order = await paid();
  await ensureLicenseDocument(order.id, db, {
    storage: storage.cloud,
    directory: root,
  });
  const { rows: docs } = await db.query<{ file_id: string; status: string }>(
    "SELECT file_id,status FROM documents WHERE order_id=$1",
    [order.id],
  );
  assert.equal(docs[0].status, "READY");
  const pdf = await file(docs[0].file_id),
    saved = storage.objects.get(pdf.object_key)!.bytes;
  assert.equal((await PDFDocument.load(saved)).getPageCount(), 1);
  assert.equal(pdf.bucket, "beatstore-test");
  assert.deepEqual(await readdir(root), []);
  const link = await issuePurchaseDownload(buyer, order.id, false, db, secret),
    token = new URL(link.url, origin).searchParams.get("token")!;
  const grant = verifyDownload(token, secret, buyer.id),
    purchased = await resolveDownload(buyer, grant, db);
  const response = await mediaResponse(
    new Request(origin + link.url),
    purchased,
    false,
    true,
    "beat.wav",
    undefined,
    storage.cloud,
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
  await assert.rejects(resolveDownload(admin, grant, db));
  await upload(p, "WAV", wav, "replacement.wav");
  assert.equal((await resolveDownload(buyer, grant, db)).id, purchased.id);
  assert.ok(storage.objects.has(purchased.object_key));
  await ensureLicenseDocument(order.id, db, {
    storage: storage.cloud,
    directory: root,
  });
  assert.deepEqual(storage.objects.get(pdf.object_key)!.bytes, saved);
  const kitId = "10000000-0000-4000-8000-000000000003";
  const kit = await getEditorProduct(admin, kitId, db);
  const archive = zip([
    { name: "USAGE.txt", data: Buffer.from(kit.usageRules) },
    { name: "kick.wav", data: Buffer.from("Test sample fixture") },
  ]);
  await upload(kit, "DRUMKIT", archive, "kit.zip");
  const kitOrder = await paid(kitId, "DRUMKIT");
  await ensureLicenseDocument(kitOrder.id, db, { storage: storage.cloud });
  assert.equal(
    (
      await db.query("SELECT id FROM documents WHERE order_id=$1", [
        kitOrder.id,
      ])
    ).rows.length,
    0,
  );
  const kitLink = await issuePurchaseDownload(
    buyer,
    kitOrder.id,
    false,
    db,
    secret,
  );
  const kitGrant = verifyDownload(
    new URL(kitLink.url, origin).searchParams.get("token")!,
    secret,
    buyer.id,
  );
  const kitFile = await resolveDownload(buyer, kitGrant, db);
  const kitResponse = await mediaResponse(
    new Request(origin + kitLink.url),
    kitFile,
    false,
    true,
    "kit.zip",
    undefined,
    storage.cloud,
  );
  assert.equal(kitResponse.headers.get("content-type"), "application/zip");
  assert.deepEqual(Buffer.from(await kitResponse.arrayBuffer()), archive);
  assert.deepEqual(await readdir(root), []);
});
test("cloud failure, ambiguous PUT and stale edits clean only their own objects; failed cleanup retains quota reservations", async () => {
  const bytes = zip([{ name: "USAGE.txt", data: Buffer.from("Test rules") }]);
  let p = await createProduct(
    admin,
    { type: "DRUMKIT", title: "Cloud failure kit" },
    db,
  );
  const before = storage.objects.size;
  storage.faults.put = true;
  await assert.rejects(upload(p, "DRUMKIT", bytes, "kit.zip"));
  storage.faults.put = false;
  assert.equal(storage.objects.size, before);
  assert.equal(
    (await db.query("SELECT id FROM files WHERE status='PENDING'")).rows.length,
    0,
  );
  storage.faults.afterPut = true;
  await assert.rejects(upload(p, "DRUMKIT", bytes, "kit.zip"));
  storage.faults.afterPut = false;
  assert.equal(storage.objects.size, before);
  storage.setAfterPut(async () => {
    await db.query("UPDATE products SET revision=revision+1 WHERE id=$1", [
      p.id,
    ]);
  });
  await assert.rejects(
    upload(p, "DRUMKIT", bytes, "kit.zip"),
    (e) => e instanceof CatalogError && e.status === 409,
  );
  storage.setAfterPut();
  assert.equal(storage.objects.size, before);
  p = await getEditorProduct(admin, p.id, db);
  storage.faults.afterPut = true;
  storage.faults.delete = true;
  await assert.rejects(upload(p, "DRUMKIT", bytes, "kit.zip"));
  storage.faults.afterPut = false;
  storage.faults.delete = false;
  const { rows: pending } = await db.query<{ id: string; size_bytes: string }>(
    "SELECT id,size_bytes FROM files WHERE status='PENDING'",
  );
  assert.equal(pending.length, 1);
  assert.ok(Number(pending[0].size_bytes) >= bytes.length);
  assert.equal(
    (await getEditorProduct(admin, p.id, db)).files.DRUMKIT,
    undefined,
  );
  const orphan = storage.requests.filter((r) => r.method === "PUT").at(-1)!;
  assert.equal(
    await storage.cloud.removeOwned(
      { bucket: "beatstore-test", object_key: orphan.key },
      pending[0].id,
    ),
    true,
  );
  await db.query("DELETE FROM files WHERE id=$1 AND status='PENDING'", [
    pending[0].id,
  ]);
  assert.deepEqual(await readdir(root), []);
});
test("document storage failure preserves a paid order and purchased file and allows retry", async () => {
  const order = await paid();
  storage.faults.afterPut = true;
  await ensureLicenseDocument(order.id, db, {
    storage: storage.cloud,
    directory: root,
  });
  storage.faults.afterPut = false;
  const { rows } = await db.query<{ id: string; status: string }>(
    "SELECT id,status FROM documents WHERE order_id=$1",
    [order.id],
  );
  assert.equal(rows[0].status, "FAILED");
  assert.equal(
    (
      await db.query<{ status: string }>(
        "SELECT status FROM orders WHERE id=$1",
        [order.id],
      )
    ).rows[0].status,
    "PAID",
  );
  assert.ok(await issuePurchaseDownload(buyer, order.id, false, db, secret));
  await ensureLicenseDocument(
    order.id,
    db,
    { storage: storage.cloud, directory: root },
    true,
  );
  assert.deepEqual(
    (
      await db.query("SELECT id,status FROM documents WHERE order_id=$1", [
        order.id,
      ])
    ).rows,
    [{ id: rows[0].id, status: "READY" }],
  );
});
test("offline import preserves existing purchase and document identities, survives failure and is repeatable", async () => {
  const order = await paid(otherBeat, "MP3"),
    snapshot = JSON.stringify(order.snapshot);
  await ensureLicenseDocument(order.id, db, { directory: root, storage: null });
  const { rows: docs } = await db.query<{ id: string; file_id: string }>(
    "SELECT id,file_id FROM documents WHERE order_id=$1",
    [order.id],
  );
  const original = await file(docs[0].file_id),
    pdf = await readFile(path.join(root, original.object_key));
  const resolve = (f: MediaFile) =>
    f.bucket === "local-document"
      ? path.join(root, f.object_key)
      : localMediaPath(f);
  storage.faults.put = true;
  await assert.rejects(importLocalFiles(db, storage.cloud, resolve));
  storage.faults.put = false;
  assert.equal((await file(original.id)).bucket, "local-document");
  assert.ok((await importLocalFiles(db, storage.cloud, resolve)).imported > 0);
  assert.deepEqual(await importLocalFiles(db, storage.cloud, resolve), {
    imported: 0,
  });
  const moved = await file(original.id);
  assert.equal(moved.checksum, original.checksum);
  assert.deepEqual(storage.objects.get(moved.object_key)!.bytes, pdf);
  assert.deepEqual(await readFile(path.join(root, original.object_key)), pdf);
  assert.equal(
    JSON.stringify(
      (
        await db.query<{ snapshot: unknown }>(
          "SELECT snapshot FROM orders WHERE id=$1",
          [order.id],
        )
      ).rows[0].snapshot,
    ),
    snapshot,
  );
  assert.deepEqual(
    (
      await db.query("SELECT id,file_id FROM documents WHERE order_id=$1", [
        order.id,
      ])
    ).rows,
    docs,
  );
  const link = await issuePurchaseDownload(buyer, order.id, false, db, secret),
    grant = verifyDownload(
      new URL(link.url, origin).searchParams.get("token")!,
      secret,
      buyer.id,
    );
  assert.equal(
    (await resolveDownload(buyer, grant, db)).bucket,
    "beatstore-test",
  );
});
test("connection check verifies private access and removes only its temporary object", async () => {
  const before = storage.objects.size;
  const anonymous = (url: string) =>
    fetch(url.replace("https://storage.yandexcloud.net", storage.endpoint), {
      headers: { Range: "bytes=0-15" },
    });
  assert.deepEqual(await checkStorage(storage.cloud, anonymous), {
    upload: true,
    download: true,
    range: true,
    anonymousDenied: true,
  });
  assert.equal(storage.objects.size, before);
  await assert.rejects(
    checkStorage(
      storage.cloud,
      async () => new Response("public", { status: 200 }),
    ),
    /Anonymous access/,
  );
  assert.equal(storage.objects.size, before);
});

test("import CLI refuses to open PGlite without an offline acknowledgement or while its application port is active", async () => {
  const directory = path.join(root, "blocked-db"),
    script = path.resolve("scripts/storage.ts");
  const env = {
    ...process.env,
    DB_DRIVER: "pglite",
    PGLITE_DATA_DIR: directory,
    BETTER_AUTH_URL: storage.endpoint,
    STORAGE_DRIVER: "yandex",
    YC_STORAGE_BUCKET: "beatstore-test",
    YC_STORAGE_PREFIX: "beatstore",
    YC_STORAGE_ACCESS_KEY_ID: "TEST-ACCESS",
    YC_STORAGE_SECRET_ACCESS_KEY: "TEST-SECRET",
  };
  const count = storage.requests.length;
  for (const [args, message] of [
    [[], /add --app-stopped/],
    [["--app-stopped"], /application port is active/],
  ] as const) {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          script,
          "import",
          ...args,
        ],
        { env, timeout: 15000 },
      ),
      (e: unknown) => {
        const error = e as { code: number; stderr: string };
        assert.equal(error.code, 1);
        assert.match(error.stderr, message);
        return true;
      },
    );
  }
  await assert.rejects(access(directory));
  assert.equal(storage.requests.length, count);
});
