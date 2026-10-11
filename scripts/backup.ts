import path from "node:path";
import { createBackup, restoreBackup } from "../src/server/operations/backup";

try {
  const passphrase = process.env.BACKUP_PASSPHRASE ?? "";
  const action = process.argv[2];
  if (action === "create") {
    console.log(
      JSON.stringify(
        await createBackup({
          root: process.cwd(),
          outputDirectory: path.resolve("work/backups"),
          passphrase,
          appStopped: process.argv.includes("--app-stopped"),
          port: Number(process.env.PORT ?? "3000"),
        }),
      ),
    );
  } else if (action === "restore") {
    const file = process.argv
      .find((value) => value.startsWith("--file="))
      ?.slice(7);
    if (!file) throw new Error("Use --file=<encrypted backup path>.");
    console.log(
      JSON.stringify(
        await restoreBackup(
          path.resolve(file),
          path.resolve("work/restores"),
          passphrase,
        ),
      ),
    );
  } else throw new Error("Use backup:create or backup:restore.");
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Backup operation failed.",
  );
  process.exitCode = 1;
}
