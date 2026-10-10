import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface SqlConnection {
  query<T>(sql: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}

export interface Database extends SqlConnection {
  transaction<T>(work: (connection: SqlConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function postgresConnection(client: Pool | PoolClient): SqlConnection {
  return {
    async query<T>(sql: string, parameters: unknown[] = []) {
      const result = await client.query(sql, parameters);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

export async function openDatabase(): Promise<Database> {
  const driver = process.env.DB_DRIVER ?? "pglite";
  if (driver === "postgres") {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for PostgreSQL.");
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
    });
    return {
      ...postgresConnection(pool),
      async transaction<T>(work: (connection: SqlConnection) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await work(postgresConnection(client));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      async close() {
        await pool.end();
      },
    };
  }
  if (driver !== "pglite") throw new Error(`Unsupported DB_DRIVER: ${driver}`);
  // Runtime data must not be bundled into the deployment output.
  const dataDir = path.resolve(
    /*turbopackIgnore: true*/ process.env.PGLITE_DATA_DIR ?? ".data/postgres",
  );
  await mkdir(dataDir, { recursive: true });
  return createEmbeddedDatabase(dataDir);
}

export async function createEmbeddedDatabase(
  dataDir?: string,
): Promise<Database> {
  const db = new PGlite(dataDir);
  await db.waitReady;
  return {
    query: <T>(sql: string, parameters: unknown[] = []) =>
      db.query<T>(sql, parameters),
    async exec(sql: string) {
      await db.exec(sql);
    },
    transaction: <T>(work: (connection: SqlConnection) => Promise<T>) =>
      db.transaction((tx) =>
        work({
          query: <R>(sql: string, parameters: unknown[] = []) =>
            tx.query<R>(sql, parameters),
          async exec(sql: string) {
            await tx.exec(sql);
          },
        }),
      ),
    async close() {
      await db.close();
    },
  };
}

const globalDatabase = globalThis as typeof globalThis & {
  beatstoreDatabase?: Promise<Database>;
};

// Keep one embedded database across Next.js development reloads.
export function getDatabase(): Promise<Database> {
  globalDatabase.beatstoreDatabase ??= openDatabase();
  return globalDatabase.beatstoreDatabase;
}
