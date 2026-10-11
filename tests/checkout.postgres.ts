import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { before, after, test } from "node:test";
import {
  openPostgresDatabase,
  type Database,
} from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "../scripts/seed";
import {
  createDemoProvider,
  type PaymentProvider,
} from "../src/server/payments/provider";
import {
  createOrder,
  getCheckoutQuote,
  getOrder,
  simulateOrder,
  applyVerifiedPayment,
} from "../src/server/checkout/service";
import type { CurrentUser } from "../src/server/auth/session";
import { ensureLicenseDocument } from "../src/server/documents/service";
import { renderLicensePdf } from "../src/server/documents/pdf";
import {
  getFreeDownload,
  issueFreeDownload,
  resolveDownload,
} from "../src/server/delivery/service";
import { verifyDownload } from "../src/server/delivery/token";
let db: Database,
  provider: PaymentProvider,
  root: string,
  pgCtl: string,
  child: ChildProcess;
const execute = promisify(execFile),
  origin = "http://127.0.0.1:3000";
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "beatstore-postgres-tests-"));
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const binaries = (await import(
    `@embedded-postgres/${platform}-${process.arch}`
  )) as { postgres: string; initdb: string; pg_ctl: string };
  pgCtl = binaries.pg_ctl;
  const password = randomUUID();
  await writeFile(path.join(root, "password.txt"), password, { mode: 0o600 });
  await execute(
    binaries.initdb,
    [
      "-D",
      path.join(root, "db"),
      "-U",
      "postgres",
      "--auth=scram-sha-256",
      `--pwfile=${path.join(root, "password.txt")}`,
      "--encoding=UTF8",
      "--locale=C",
      "--no-sync",
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  child = spawn(
    binaries.postgres,
    [
      "-D",
      path.join(root, "db"),
      "-p",
      String(port),
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "unix_socket_directories=",
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, LC_MESSAGES: "C" },
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("PostgreSQL startup timeout")),
      30000,
    );
    let output = "";
    child.stderr!.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("database system is ready to accept connections")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`PostgreSQL exited ${code}: ${output}`));
    });
  });
  db = openPostgresDatabase(
    `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
  );
  await migrate(db);
  await seedDemo(db);
  provider = createDemoProvider(db);
  const version = await db.query<{ v: string }>("SELECT version() v");
  console.log("Concurrent scenarios use:", version.rows[0].v.split(" on ")[0]);
});
after(async () => {
  await db?.close();
  if (child?.exitCode === null)
    await execute(
      pgCtl,
      ["-D", path.join(root, "db"), "stop", "-m", "fast", "-w"],
      { windowsHide: true, timeout: 15000 },
    );
  if (root) {
    assert.ok(
      path.isAbsolute(root) &&
        path
          .resolve(root)
          .startsWith(
            path.resolve(tmpdir()) + path.sep + "beatstore-postgres-tests-",
          ),
    );
    await rm(root, { recursive: true, force: true });
  }
});
async function user(): Promise<CurrentUser> {
  const id = randomUUID(),
    email = `${id}@example.test`;
  await db.query(
    `INSERT INTO users(id,email,artist_name) VALUES ($1,$2,'Concurrent Artist')`,
    [id, email],
  );
  return { id, email, name: "Concurrent Artist", role: "CUSTOMER" };
}
async function beat() {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO products(id,type,title,status,discount_percent,cover_file_id,thumbnail_file_id,preview_file_id,duration_seconds,authors,bpm,musical_key,royalty_percent,project_requirements) SELECT $1,type,title,status,discount_percent,cover_file_id,thumbnail_file_id,preview_file_id,duration_seconds,authors,bpm,musical_key,royalty_percent,project_requirements FROM products WHERE id='10000000-0000-4000-8000-000000000001'`,
      [id],
    );
    await tx.query(
      `INSERT INTO offers(product_id,kind,base_price_kopecks,file_id,terms_version_id) SELECT $1,kind,base_price_kopecks,file_id,terms_version_id FROM offers WHERE product_id='10000000-0000-4000-8000-000000000001'`,
      [id],
    );
  });
  return id;
}
async function input(
  who: CurrentUser,
  id: string,
  kind = "EXCLUSIVE",
  requestKey = randomUUID(),
) {
  const quote = await getCheckoutQuote(who, id, kind, db);
  return {
    productId: id,
    kind,
    requestKey,
    revision: quote.revision,
    accepted: true,
  };
}
test("two concurrent exclusive buyers yield exactly one reservation and one sale", async () => {
  const id = await beat(),
    a = await user(),
    b = await user(),
    ia = await input(a, id),
    ib = await input(b, id);
  const results = await Promise.allSettled([
    createOrder(a, ia, db, provider, origin),
    createOrder(b, ib, db, provider, origin),
  ]);
  const winners = results.filter((r) => r.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const order = winners[0].value,
    owner = order.snapshot.buyer.id === a.id ? a : b;
  await Promise.all([
    simulateOrder(owner, order.id, "succeeded", db, provider, origin),
    simulateOrder(owner, order.id, "succeeded", db, provider, origin),
  ]);
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::integer n FROM orders WHERE product_id=$1 AND purchase_kind='EXCLUSIVE' AND paid_at IS NOT NULL`,
    [id],
  );
  assert.equal(rows[0].n, 1);
  assert.equal((await getOrder(owner, order.id, db)).status, "PAID");
});
test("ordinary checkout racing exclusive checkout never opens both payments", async () => {
  const id = await beat(),
    a = await user(),
    b = await user(),
    ia = await input(a, id, "WAV"),
    ib = await input(b, id);
  const results = await Promise.allSettled([
    createOrder(a, ia, db, provider, origin),
    createOrder(b, ib, db, provider, origin),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::integer n FROM orders WHERE product_id=$1 AND status='AWAITING_PAYMENT'`,
    [id],
  );
  assert.equal(rows[0].n, 1);
});
test("concurrent retries reuse one order and payment; late pending never regresses success", async () => {
  const id = await beat(),
    who = await user(),
    body = await input(who, id, "WAV");
  const orders = await Promise.all(
    Array.from({ length: 4 }, () =>
      createOrder(who, body, db, provider, origin),
    ),
  );
  assert.equal(new Set(orders.map((o) => o.id)).size, 1);
  const order = orders[0];
  await simulateOrder(who, order.id, "succeeded", db, provider, origin);
  const { rows } = await db.query<{ id: string; provider_payment_id: string }>(
    "SELECT id,provider_payment_id FROM payments WHERE order_id=$1",
    [order.id],
  );
  assert.equal(rows.length, 1);
  const result = await provider.get(rows[0].provider_payment_id);
  await applyVerifiedPayment(
    order.id,
    rows[0].id,
    { ...result, status: "pending", paid: false },
    db,
  );
  assert.equal((await getOrder(who, order.id, db)).status, "PAID");
});

test("concurrent document requests render and publish one immutable PDF", async () => {
  const id = await beat(),
    who = await user(),
    body = await input(who, id, "WAV");
  const o = await createOrder(who, body, db, provider, origin);
  await simulateOrder(who, o.id, "succeeded", db, provider, origin);
  let calls = 0;
  const directory = path.join(root, "documents");
  await Promise.all(
    Array.from({ length: 6 }, () =>
      ensureLicenseDocument(
        o.id,
        db,
        {
          directory,
          render: (input) => {
            calls++;
            return renderLicensePdf(input);
          },
        },
        true,
      ),
    ),
  );
  const { rows } = await db.query<{
    status: string;
    object_key: string;
    size_bytes: string;
  }>(
    "SELECT d.status,f.object_key,f.size_bytes FROM documents d JOIN files f ON f.id=d.file_id WHERE d.order_id=$1",
    [o.id],
  );
  assert.equal(calls, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "READY");
  assert.equal(
    (await readFile(path.join(directory, rows[0].object_key))).length,
    Number(rows[0].size_bytes),
  );
  await assert.rejects(
    db.query("UPDATE documents SET status='FAILED' WHERE order_id=$1", [o.id]),
    /immutable/,
  );
});

test("a free grant racing exclusive confirmation cannot download after the sale", async () => {
  const id = await beat(),
    who = await user(),
    freeBuyer = await user(),
    body = await input(who, id);
  const o = await createOrder(who, body, db, provider, origin),
    q = await getFreeDownload(freeBuyer, id, db),
    secret = "A-separate-Postgres-download-secret-of-48-characters";
  const [free, paid] = await Promise.allSettled([
    issueFreeDownload(
      freeBuyer,
      id,
      { revision: q.revision, termsId: q.termsId, accepted: true },
      db,
      secret,
    ),
    simulateOrder(who, o.id, "succeeded", db, provider, origin),
  ]);
  assert.equal(paid.status, "fulfilled");
  if (free.status === "fulfilled") {
    const token = new URL(free.value.url, origin).searchParams.get("token")!;
    await assert.rejects(
      resolveDownload(
        freeBuyer,
        verifyDownload(token, secret, freeBuyer.id),
        db,
      ),
      /недоступно/,
    );
  }
  await assert.rejects(getFreeDownload(freeBuyer, id, db), /недоступно/);
});
