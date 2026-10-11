import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openPostgresDatabase } from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { createBackup, restoreBackup } from "../src/server/operations/backup";

const execute = promisify(execFile);
test(
  "PostgreSQL dump and file recovery preserve buyer records, password hashes and schema",
  {
    skip:
      !process.env.BACKUP_TEST_DATABASE_URL &&
      "Requires the isolated PostgreSQL backup CI service",
  },
  async () => {
    const url = new URL(process.env.BACKUP_TEST_DATABASE_URL!);
    assert(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.equal(url.pathname, "/beatstore_backup_test");
    const root = await mkdtemp(
      path.join(tmpdir(), "beatstore-pg-backup-tests-"),
    );
    const restoredName = `beatstore_backup_restore_${randomUUID().replaceAll("-", "")}`;
    const db = openPostgresDatabase(url.href);
    const id = randomUUID(),
      passwordHash = "preserved-test-password-hash";
    let created = false;
    try {
      await migrate(db, path.resolve("migrations"));
      await db.query(
        "INSERT INTO users(id,email,artist_name,role) VALUES($1,$2,$3,'ADMIN')",
        [id, "recovery@example.test", "Recovery Artist"],
      );
      await db.query(
        "INSERT INTO auth_accounts(id,user_id,account_id,provider_id,password) VALUES($1,$2,$3,'credential',$4)",
        [randomUUID(), id, id, passwordHash],
      );
      await mkdir(path.join(root, ".data/uploads"), { recursive: true });
      const bytes = Buffer.alloc(65536, 9);
      await writeFile(path.join(root, ".data/uploads/purchased.zip"), bytes);
      const passphrase = "ci-backup-secret-is-not-a-real-account";
      const backup = await createBackup({
        root,
        outputDirectory: path.join(root, "backups"),
        passphrase,
        appStopped: true,
        port: 3101,
        env: {
          DB_DRIVER: "postgres",
          DATABASE_URL: url.href,
          STORAGE_DRIVER: "local",
          PG_DUMP_BIN: process.env.PG_DUMP_BIN,
        },
      });
      const recovered = await restoreBackup(
        backup.file,
        path.join(root, "recoveries"),
        passphrase,
      );
      assert.equal(recovered.driver, "postgres");
      await db.exec(`CREATE DATABASE ${restoredName}`);
      created = true;
      await execute(
        process.env.PSQL_BIN ?? "psql",
        [
          "-X",
          "--single-transaction",
          "--set=ON_ERROR_STOP=on",
          `--file=${path.join(recovered.root, "database.sql")}`,
        ],
        {
          env: {
            ...process.env,
            PGHOST: url.hostname,
            PGPORT: url.port || "5432",
            PGUSER: decodeURIComponent(url.username),
            PGPASSWORD: decodeURIComponent(url.password),
            PGDATABASE: restoredName,
          },
          windowsHide: true,
          timeout: 30000,
        },
      );
      const recoveredUrl = new URL(url);
      recoveredUrl.pathname = `/${restoredName}`;
      const restored = openPostgresDatabase(recoveredUrl.href);
      try {
        assert.deepEqual(
          (await restored.query("SELECT id,artist_name FROM users")).rows,
          [{ id, artist_name: "Recovery Artist" }],
        );
        assert.equal(
          (
            await restored.query<{ password: string }>(
              "SELECT password FROM auth_accounts WHERE user_id=$1",
              [id],
            )
          ).rows[0].password,
          passwordHash,
        );
        assert.equal(
          (await restored.query("SELECT version FROM schema_migrations")).rows
            .length,
          (await db.query("SELECT version FROM schema_migrations")).rows.length,
        );
      } finally {
        await restored.close();
      }
      assert.deepEqual(
        await readFile(
          path.join(recovered.root, ".data/uploads/purchased.zip"),
        ),
        bytes,
      );
    } finally {
      if (created) await db.exec(`DROP DATABASE ${restoredName}`);
      await db.close();
      assert(
        root.startsWith(path.join(tmpdir(), "beatstore-pg-backup-tests-")),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
);
