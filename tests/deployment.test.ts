import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "better-auth/crypto";
import {
  createEmbeddedDatabase,
  type Database,
} from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import {
  checkDeployment,
  publicConfiguration,
} from "../src/server/operations/deployment";

let db: Database, root: string;
const id = randomUUID();
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "beatstore-deployment-tests-"));
  await cp(path.resolve("migrations"), path.join(root, "migrations"), {
    recursive: true,
  });
  db = await createEmbeddedDatabase();
  await migrate(db, path.join(root, "migrations"));
});
after(async () => {
  await db?.close();
  assert(root.startsWith(path.join(tmpdir(), "beatstore-deployment-tests-")));
  await rm(root, { recursive: true, force: true });
});

test("public deployment profile refuses local URLs, PGlite, external payments and incomplete backup settings", () => {
  const env = {
    BETTER_AUTH_SECRET: "public-test-secret-at-least-32-characters",
    BETTER_AUTH_URL: "https://demo.example.test",
    MAIL_DRIVER: "smtp",
    SMTP_HOST: "smtp.example.test",
    SMTP_USER: "sender",
    SMTP_PASSWORD: "test-password",
    SMTP_FROM: "sender@example.test",
    DB_DRIVER: "postgres",
    DATABASE_URL: "postgresql://test:password@127.0.0.1/test",
    BACKUP_PASSPHRASE: "separate-private-backup-passphrase",
  };
  assert.equal(publicConfiguration(env).baseURL, env.BETTER_AUTH_URL);
  assert.throws(
    () =>
      publicConfiguration({ ...env, BETTER_AUTH_URL: "http://127.0.0.1:3000" }),
    /public HTTPS/,
  );
  assert.throws(
    () => publicConfiguration({ ...env, DB_DRIVER: "pglite" }),
    /PostgreSQL/,
  );
  assert.throws(
    () => publicConfiguration({ ...env, PAYMENT_PROVIDER: "yookassa" }),
    /demonstration payments/,
  );
  assert.throws(
    () => publicConfiguration({ ...env, STORAGE_DRIVER: "yandex" }),
    /local storage/,
  );
  assert.throws(
    () => publicConfiguration({ ...env, BACKUP_PASSPHRASE: "" }),
    /BACKUP_PASSPHRASE/,
  );
});

test("readiness catches missing owner, known passwords and changed migrations without altering accounts", async () => {
  await assert.rejects(checkDeployment(db, root), /Create the owner/);
  await db.query(
    "INSERT INTO users(id,email,artist_name,role) VALUES($1,$2,$3,'ADMIN')",
    [id, "owner@example.test", "Owner"],
  );
  await db.query(
    "INSERT INTO auth_accounts(id,user_id,account_id,provider_id,password) VALUES($1,$2,$3,'credential',$4)",
    [randomUUID(), id, id, await hashPassword("Beatstore-admin-2026")],
  );
  await assert.rejects(
    checkDeployment(db, root),
    /Known demonstration passwords/,
  );
  const password = await hashPassword("strong-private-owner-password");
  await db.query("UPDATE auth_accounts SET password=$1 WHERE user_id=$2", [
    password,
    id,
  ]);
  assert.deepEqual(await checkDeployment(db, root), {
    migrations: true,
    owner: true,
    passwords: true,
    writableStorage: true,
  });
  assert.equal(
    (
      await db.query<{ password: string }>(
        "SELECT password FROM auth_accounts WHERE user_id=$1",
        [id],
      )
    ).rows[0].password,
    password,
  );
  assert.deepEqual(await readdir(path.join(root, ".data")), []);
  const migration = (await readdir(path.join(root, "migrations"))).find(
    (name) => name.endsWith(".sql"),
  )!;
  await writeFile(
    path.join(root, "migrations", migration),
    `${await readFile(path.join(root, "migrations", migration), "utf8")}\n-- corrupted test copy`,
  );
  await assert.rejects(checkDeployment(db, root), /current migrations/);
});
