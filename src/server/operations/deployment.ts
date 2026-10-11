import { verifyPassword } from "better-auth/crypto";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readAuthConfig } from "../auth/config";
import { isLoopback, readMailConfig } from "../auth/mail-config";
import type { Database } from "../db/connection";

export function publicConfiguration(env: Record<string, string | undefined>) {
  const auth = readAuthConfig(env);
  if (isLoopback(new URL(auth.baseURL).hostname))
    throw new Error("Set the public HTTPS application origin.");
  if (env.DB_DRIVER !== "postgres" || !env.DATABASE_URL)
    throw new Error("Public deployment requires standalone PostgreSQL.");
  if (readMailConfig(env).driver !== "smtp")
    throw new Error("Public deployment requires SMTP.");
  if ((env.PAYMENT_PROVIDER ?? "demo") !== "demo")
    throw new Error(
      "This deployment profile uses demonstration payments only.",
    );
  if ((env.STORAGE_DRIVER ?? "local") !== "local")
    throw new Error("This deployment profile backs up local storage only.");
  if (!env.BACKUP_PASSPHRASE || env.BACKUP_PASSPHRASE.length < 16)
    throw new Error("Configure a separate BACKUP_PASSPHRASE.");
  return auth;
}

export async function checkDeployment(db: Database, root: string) {
  const migrations = (await readdir(path.join(root, "migrations")))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const { rows: applied } = await db.query<{
    version: string;
    checksum: string;
  }>("SELECT version,checksum FROM schema_migrations");
  for (const name of migrations) {
    const checksum = createHash("sha256")
      .update(await readFile(path.join(root, "migrations", name)))
      .digest("hex");
    if (
      !applied.some(
        (item) => item.version === name && item.checksum === checksum,
      )
    )
      throw new Error("Apply current migrations before publishing.");
  }
  const { rows: owners } = await db.query(
    "SELECT id FROM users WHERE role='ADMIN'",
  );
  if (!owners.length)
    throw new Error("Create the owner with account:owner before publishing.");
  const { rows: accounts } = await db.query<{ password: string }>(
    "SELECT password FROM auth_accounts WHERE provider_id='credential' AND password IS NOT NULL",
  );
  for (const account of accounts)
    for (const password of ["Beatstore-demo-2026", "Beatstore-admin-2026"])
      if (await verifyPassword({ hash: account.password, password }))
        throw new Error(
          "Known demonstration passwords must be changed before publishing.",
        );
  const directory = path.join(root, ".data");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const probe = path.join(directory, `.deployment-${randomUUID()}`);
  try {
    await writeFile(probe, "storage check", { flag: "wx", mode: 0o600 });
  } finally {
    await rm(probe, { force: true });
  }
  return {
    migrations: true,
    owner: true,
    passwords: true,
    writableStorage: true,
  };
}
