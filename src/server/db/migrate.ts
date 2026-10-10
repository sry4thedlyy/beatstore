import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./connection";

export async function migrate(
  db: Database,
  directory = path.resolve("migrations"),
) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(directory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    const sql = await readFile(path.join(directory, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    await db.transaction(async (tx) => {
      await tx.exec("LOCK TABLE schema_migrations IN EXCLUSIVE MODE");
      const { rows } = await tx.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [file],
      );
      if (rows[0]) {
        if (rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${file}`);
        return;
      }
      await tx.exec(sql);
      await tx.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [file, checksum],
      );
    });
  }
}
