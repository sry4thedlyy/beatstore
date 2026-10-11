import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
} from "node:crypto";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import * as tar from "tar";

const execute = promisify(execFile);
const MAGIC = Buffer.from("BSTBACK1");
const HEADER_SIZE = MAGIC.length + 16 + 12;
const DATA_FOLDERS = ["demo-assets", "uploads", "documents", "owner-access"];
const MAX_BYTES = 8 * 1024 ** 3;
type Environment = Record<string, string | undefined>;
interface Manifest {
  format: 1;
  driver: "pglite" | "postgres";
  createdAt: string;
}

export async function requireStopped(appStopped: boolean, port = 3000) {
  if (!appStopped)
    throw new Error("Stop the app and add --app-stopped before backing up.");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid local app port.");
  const active = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (e: NodeJS.ErrnoException) => {
      socket.destroy();
      if (e.code === "ECONNREFUSED") resolve(false);
      else reject(new Error("Cannot confirm that the app is stopped."));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Cannot confirm that the app is stopped."));
    });
  });
  if (active)
    throw new Error(
      "The local app port is active. Stop the app before backing up.",
    );
}

async function key(passphrase: string, salt: Buffer) {
  if (passphrase.length < 16)
    throw new Error("BACKUP_PASSPHRASE must contain at least 16 characters.");
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 },
      (error, value) => (error ? reject(error) : resolve(value)),
    );
  });
}

async function regularTree(directory: string) {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Error(
      "Backup paths must contain regular files and directories only.",
    );
  let size = stat.isFile() ? stat.size : 0;
  if (stat.isDirectory())
    for (const child of await readdir(directory))
      size += await regularTree(path.join(directory, child));
  if (size > MAX_BYTES)
    throw new Error("Backup exceeds the 8 GiB demonstration limit.");
  return size;
}

async function present(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

async function removeOwned(directory: string, parent: string) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(parent))
    throw new Error("Invalid temporary backup directory.");
  await rm(directory, { recursive: true, force: true });
}

export async function createBackup(options: {
  root: string;
  outputDirectory: string;
  passphrase: string;
  appStopped: boolean;
  port?: number;
  env?: Environment;
}) {
  const env = options.env ?? process.env;
  const driver = env.DB_DRIVER ?? "pglite";
  if (driver !== "pglite" && driver !== "postgres")
    throw new Error("Unsupported backup database driver.");
  if ((env.STORAGE_DRIVER ?? "local") !== "local")
    throw new Error(
      "This backup covers local files only. Cloud objects need a separate backup.",
    );
  const root = path.resolve(options.root);
  if (
    driver === "pglite" &&
    path.resolve(root, env.PGLITE_DATA_DIR ?? ".data/postgres") !==
      path.join(root, ".data/postgres")
  )
    throw new Error("Portable PGlite backup requires .data/postgres.");
  await requireStopped(options.appStopped, options.port);
  if (await present(path.join(root, ".data"))) {
    const stat = await lstat(path.join(root, ".data"));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Application data must be a regular directory.");
  }
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = createCipheriv(
    "aes-256-gcm",
    await key(options.passphrase, salt),
    iv,
  );
  cipher.setAAD(header);
  const output = path.resolve(options.outputDirectory);
  if (
    output === path.join(root, ".data") ||
    output.startsWith(path.join(root, ".data") + path.sep)
  )
    throw new Error("Keep backups outside the application data directory.");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(path.join(output, "staging-"));
  const file = path.join(
    output,
    `beatstore-${Date.now()}-${randomUUID()}.bsbackup`,
  );
  const partial = `${file}.part`;
  try {
    const entries = ["backup.json"];
    for (const folder of [
      ...DATA_FOLDERS,
      ...(driver === "pglite" ? ["postgres"] : []),
    ]) {
      const relative = `.data/${folder}`,
        source = path.join(root, relative);
      if (!(await present(source))) {
        if (folder === "postgres")
          throw new Error("PGlite database was not found.");
        continue;
      }
      await regularTree(source);
      await cp(source, path.join(stage, relative), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      entries.push(relative);
    }
    if (await present(path.join(root, ".env.local"))) {
      await regularTree(path.join(root, ".env.local"));
      await cp(path.join(root, ".env.local"), path.join(stage, ".env.local"), {
        force: false,
        errorOnExist: true,
      });
      entries.push(".env.local");
    }
    if (driver === "postgres") {
      const databaseUrl = new URL(env.DATABASE_URL ?? "");
      if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol))
        throw new Error("Set DATABASE_URL for the PostgreSQL dump.");
      try {
        await execute(
          env.PG_DUMP_BIN ?? "pg_dump",
          [
            "--format=plain",
            "--no-owner",
            "--no-privileges",
            `--file=${path.join(stage, "database.sql")}`,
          ],
          {
            env: {
              ...process.env,
              PGHOST: databaseUrl.hostname.replace(/^\[|\]$/g, ""),
              PGPORT: databaseUrl.port || "5432",
              PGUSER: decodeURIComponent(databaseUrl.username),
              PGPASSWORD: decodeURIComponent(databaseUrl.password),
              PGDATABASE: decodeURIComponent(databaseUrl.pathname.slice(1)),
              PGSSLMODE: databaseUrl.searchParams.get("sslmode") ?? "prefer",
            },
            windowsHide: true,
            timeout: 120000,
          },
        );
      } catch {
        throw new Error(
          "PostgreSQL dump failed. Check pg_dump version and database access.",
        );
      }
      entries.push("database.sql");
    }
    await writeFile(
      path.join(stage, "backup.json"),
      JSON.stringify({
        format: 1,
        driver,
        createdAt: new Date().toISOString(),
      } satisfies Manifest),
      { mode: 0o600 },
    );
    await regularTree(stage);
    await writeFile(partial, header, { flag: "wx", mode: 0o600 });
    await pipeline(
      tar.c({ cwd: stage, gzip: true, portable: true, strict: true }, entries),
      cipher,
      createWriteStream(partial, { flags: "a" }),
    );
    await appendFile(partial, cipher.getAuthTag());
    await rename(partial, file);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return { file, sha256: hash.digest("hex"), driver };
  } finally {
    await rm(partial, { force: true });
    await removeOwned(stage, output);
  }
}

function allowedEntry(entryPath: string, type: string, size: number) {
  const name = entryPath.replace(/\/$/, "");
  if (
    !["File", "Directory"].includes(type) ||
    !name ||
    /[\\:\r\n\0]/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Unsafe backup entry.");
  if (
    !["backup.json", ".env.local", "database.sql", ".data"].includes(name) &&
    !["postgres", ...DATA_FOLDERS].some(
      (folder) =>
        name === `.data/${folder}` || name.startsWith(`.data/${folder}/`),
    )
  )
    throw new Error("Unexpected backup path.");
  if (size > 2 * 1024 ** 3) throw new Error("Backup entry is too large.");
}

// Recovery always creates a separate folder; it never overwrites the live application.
export async function restoreBackup(
  file: string,
  outputDirectory: string,
  passphrase: string,
) {
  const output = path.resolve(outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(output, "restore-"));
  const archive = path.join(root, "payload.tar.gz");
  try {
    const input = await open(file, "r");
    let header: Buffer, tag: Buffer, size: number;
    try {
      size = (await input.stat()).size;
      if (size < HEADER_SIZE + 17 || size > MAX_BYTES)
        throw new Error("Invalid backup size.");
      header = Buffer.alloc(HEADER_SIZE);
      tag = Buffer.alloc(16);
      await input.read(header, 0, header.length, 0);
      await input.read(tag, 0, tag.length, size - 16);
    } finally {
      await input.close();
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC))
      throw new Error("Invalid backup format.");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      await key(passphrase, header.subarray(8, 24)),
      header.subarray(24, 36),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    try {
      await pipeline(
        createReadStream(file, { start: HEADER_SIZE, end: size - 17 }),
        decipher,
        createWriteStream(archive, { flags: "wx", mode: 0o600 }),
      );
    } catch {
      throw new Error("Backup is damaged or the passphrase is incorrect.");
    }
    let bytes = 0,
      count = 0;
    // Validate every path and type after authentication and before extracting anything.
    await tar.t({
      file: archive,
      strict: true,
      onReadEntry: (entry) => {
        allowedEntry(entry.path, entry.type, entry.size);
        bytes += entry.size;
        if (bytes > MAX_BYTES || ++count > 100000)
          throw new Error("Backup contents exceed the demonstration limit.");
      },
    });
    await tar.x({
      file: archive,
      cwd: root,
      strict: true,
      preserveOwner: false,
      umask: 0o077,
      filter: (p, entry) => {
        if (!("type" in entry)) throw new Error("Invalid archive entry.");
        allowedEntry(p, entry.type, entry.size);
        return true;
      },
    });
    const manifest = JSON.parse(
      await readFile(path.join(root, "backup.json"), "utf8"),
    ) as Manifest;
    if (
      manifest.format !== 1 ||
      !["pglite", "postgres"].includes(manifest.driver)
    )
      throw new Error("Invalid backup manifest.");
    if (
      !(await present(
        path.join(
          root,
          manifest.driver === "postgres" ? "database.sql" : ".data/postgres",
        ),
      ))
    )
      throw new Error("Backup database is missing.");
    await rm(archive);
    return { root, ...manifest };
  } catch (error) {
    await removeOwned(root, output);
    throw error;
  }
}
