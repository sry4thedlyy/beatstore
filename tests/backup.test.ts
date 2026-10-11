import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEmbeddedDatabase } from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { createBackup, restoreBackup } from "../src/server/operations/backup";

let root: string, port: number, file: string;
const passphrase = "test-backup-passphrase-kept-separately";
const project = process.cwd();
const userId = "90000000-0000-4000-8000-000000000001";
const env = { DB_DRIVER: "pglite", STORAGE_DRIVER: "local" };
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "beatstore-backup-tests-"));
  await mkdir(path.join(root, ".data/uploads"), { recursive: true });
  await writeFile(
    path.join(root, ".data/uploads/purchased.wav"),
    Buffer.alloc(1024 * 1024, 7),
  );
  await writeFile(
    path.join(root, ".env.local"),
    "BETTER_AUTH_SECRET=private-config-for-recovery\n",
  );
  const db = await createEmbeddedDatabase(path.join(root, ".data/postgres"));
  try {
    await migrate(db, path.join(project, "migrations"));
    await db.query("INSERT INTO users(id,email,artist_name) VALUES($1,$2,$3)", [
      userId,
      "backup@example.test",
      "Backup Artist",
    ]);
  } finally {
    await db.close();
  }
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
});
after(async () => {
  assert(
    path
      .resolve(root)
      .startsWith(
        path.resolve(tmpdir()) + path.sep + "beatstore-backup-tests-",
      ),
  );
  await rm(root, { recursive: true, force: true });
});

test("encrypted recovery preserves a real PGlite database, files and secrets in a separate directory", async () => {
  const backup = await createBackup({
    root,
    outputDirectory: path.join(root, "backups"),
    passphrase,
    appStopped: true,
    port,
    env,
  });
  file = backup.file;
  assert.match(backup.sha256, /^[a-f0-9]{64}$/);
  const encrypted = await readFile(file);
  assert(!encrypted.includes(Buffer.from("private-config-for-recovery")));
  assert(!encrypted.includes(Buffer.from("Backup Artist")));
  const recovery = await restoreBackup(
    file,
    path.join(root, "recoveries"),
    passphrase,
  );
  assert.notEqual(recovery.root, root);
  assert.equal(recovery.driver, "pglite");
  const db = await createEmbeddedDatabase(
    path.join(recovery.root, ".data/postgres"),
  );
  try {
    const { rows } = await db.query<{ id: string; artist_name: string }>(
      "SELECT id,artist_name FROM users",
    );
    assert.deepEqual(rows, [{ id: userId, artist_name: "Backup Artist" }]);
    assert(
      (await db.query("SELECT version FROM schema_migrations")).rows.length > 0,
    );
  } finally {
    await db.close();
  }
  assert.deepEqual(
    await readFile(path.join(recovery.root, ".data/uploads/purchased.wav")),
    await readFile(path.join(root, ".data/uploads/purchased.wav")),
  );
  assert.equal(
    await readFile(path.join(recovery.root, ".env.local"), "utf8"),
    await readFile(path.join(root, ".env.local"), "utf8"),
  );
  assert.equal(
    (await readdir(path.join(root, "backups"))).filter((name) =>
      name.startsWith("staging-"),
    ).length,
    0,
  );
});

test("wrong keys and corrupted copies fail before extraction and never overwrite a successful recovery", async () => {
  const directory = path.join(root, "recoveries"),
    initial = await readdir(directory);
  await assert.rejects(
    restoreBackup(file, directory, "different-backup-passphrase"),
    /damaged|incorrect/,
  );
  const damaged = await readFile(file);
  damaged[Math.floor(damaged.length / 2)] ^= 1;
  const corruptedFile = path.join(root, "corrupted.bsbackup");
  await writeFile(corruptedFile, damaged);
  await assert.rejects(
    restoreBackup(corruptedFile, directory, passphrase),
    /damaged|incorrect/,
  );
  assert.deepEqual(await readdir(directory), initial);
});

test("offline and storage guards refuse to read a running database or claim that cloud objects are backed up", async () => {
  const options = {
    root,
    outputDirectory: path.join(root, "guarded"),
    passphrase,
    appStopped: false,
    port,
    env,
  };
  await assert.rejects(createBackup(options), /app-stopped/);
  const socket = createServer();
  await new Promise<void>((resolve) =>
    socket.listen(port, "127.0.0.1", resolve),
  );
  try {
    await assert.rejects(
      createBackup({ ...options, appStopped: true }),
      /port is active/,
    );
  } finally {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
  await assert.rejects(
    createBackup({ ...options, env: { ...env, STORAGE_DRIVER: "yandex" } }),
    /Cloud objects/,
  );
  await assert.rejects(
    createBackup({
      ...options,
      env: { ...env, PGLITE_DATA_DIR: "../other-data" },
    }),
    /Portable PGlite/,
  );
  await assert.rejects(
    createBackup({ ...options, appStopped: true, passphrase: "short" }),
    /16 characters/,
  );
});
