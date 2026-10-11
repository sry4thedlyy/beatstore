import { openDatabase, type Database } from "../src/server/db/connection";
import { readMailConfig } from "../src/server/auth/mail-config";
import { createSmtpMailer } from "../src/server/auth/mail";
import {
  checkDeployment,
  publicConfiguration,
} from "../src/server/operations/deployment";

let db: Database | undefined,
  mailer: ReturnType<typeof createSmtpMailer> | undefined;
try {
  publicConfiguration(process.env);
  db = await openDatabase();
  const checks = await checkDeployment(db, process.cwd());
  const config = readMailConfig();
  if (config.driver !== "smtp") throw new Error("Configure SMTP.");
  mailer = createSmtpMailer(config);
  await mailer.verify();
  console.log(
    JSON.stringify({ ...checks, smtpConnection: true, demoPayments: true }),
  );
} catch (error) {
  // Configuration errors are sanitized; SQL and SMTP responses never reach output.
  const message =
    error instanceof Error &&
    (error.message.startsWith("Set ") ||
      error.message.startsWith("Configure ") ||
      error.message.startsWith("Public ") ||
      error.message.startsWith("This deployment ") ||
      error.message.startsWith("Apply ") ||
      error.message.startsWith("Create ") ||
      error.message.startsWith("Known ") ||
      error.message.startsWith("SMTP_"))
      ? error.message
      : "Deployment check failed. Check server configuration, database and file permissions.";
  console.error(message);
  process.exitCode = 1;
} finally {
  mailer?.close();
  await db?.close();
}
