import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

// An isolated cluster, never DATABASE_URL or the development database.
export async function acceptancePostgres(root: string) {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const binaries = process.env.PG_BIN_DIR
    ? {
        initdb: path.join(process.env.PG_BIN_DIR, "initdb"),
        postgres: path.join(process.env.PG_BIN_DIR, "postgres"),
        pg_ctl: path.join(process.env.PG_BIN_DIR, "pg_ctl"),
      }
    : ((await import(`@embedded-postgres/${platform}-${process.arch}`)) as {
        initdb: string;
        postgres: string;
        pg_ctl: string;
      });
  const directory = path.join(root, "postgres");
  const passwordFile = path.join(root, "pg-password");
  const password = randomBytes(32).toString("hex");
  let child: ChildProcess | undefined;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null)
      await execute(
        binaries.pg_ctl,
        ["-D", directory, "stop", "-m", "fast", "-w", "-t", "30"],
        { windowsHide: true, timeout: 35000 },
      );
  }
  try {
    await writeFile(passwordFile, password, { mode: 0o600 });
    await execute(
      binaries.initdb,
      [
        "-D",
        directory,
        "-U",
        "postgres",
        "--auth=scram-sha-256",
        `--pwfile=${passwordFile}`,
        "--encoding=UTF8",
        "--locale=C",
        "--no-sync",
      ],
      { windowsHide: true, timeout: 60000 },
    );
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", resolve);
    });
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    child = spawn(
      binaries.postgres,
      [
        "-D",
        directory,
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
        () => reject(new Error("Acceptance PostgreSQL startup timeout")),
        30000,
      );
      child!.stderr!.on("data", (chunk: Buffer) => {
        if (
          chunk
            .toString()
            .includes("database system is ready to accept connections")
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child!.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child!.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Acceptance PostgreSQL stopped"));
      });
    });
    return {
      url: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
