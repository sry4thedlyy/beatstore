import { createConnection } from "node:net";
import { openDatabase, type Database } from "../src/server/db/connection";
import {
  yandexStorage,
  type YandexStorage,
} from "../src/server/storage/yandex";
import { storageDriver } from "../src/server/storage/config";
import { importLocalFiles } from "../src/server/storage/import";
import { checkStorage } from "../src/server/storage/check";

async function requireOfflinePGlite() {
  if ((process.env.DB_DRIVER ?? "pglite") !== "pglite") return;
  if (!process.argv.includes("--app-stopped"))
    throw new Error(
      "Stop the application and add --app-stopped before importing PGlite files.",
    );
  const url = new URL(process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Offline PGlite import requires a local application URL.");
  const active = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({
      host: url.hostname === "[::1]" ? "::1" : url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (e: NodeJS.ErrnoException) => {
      socket.destroy();
      if (e.code === "ECONNREFUSED") resolve(false);
      else
        reject(
          new Error("Cannot confirm that the local application is stopped."),
        );
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(
        new Error("Cannot confirm that the local application is stopped."),
      );
    });
  });
  if (active)
    throw new Error(
      "The application port is active. Stop it before opening PGlite from this command.",
    );
}
let db: Database | undefined, storage: YandexStorage | undefined;
try {
  const action = process.argv[2];
  if (!["check", "import"].includes(action))
    throw new Error("Use storage:check or storage:import.");
  if (storageDriver() !== "yandex")
    throw new Error(
      "Configure STORAGE_DRIVER=yandex and the static key in .env.local first.",
    );
  storage = yandexStorage();
  if (action === "check")
    console.log(JSON.stringify(await checkStorage(storage)));
  else {
    await requireOfflinePGlite();
    db = await openDatabase();
    console.log(JSON.stringify(await importLocalFiles(db, storage)));
  }
} catch (e) {
  // StorageError is sanitized; credentials and SDK request details never reach CLI output.
  console.error(e instanceof Error ? e.message : "Storage command failed.");
  process.exitCode = 1;
} finally {
  await db?.close();
  storage?.close();
}
