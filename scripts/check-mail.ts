import { readAuthConfig } from "../src/server/auth/config";
import { readMailConfig } from "../src/server/auth/mail-config";
import { createSmtpMailer } from "../src/server/auth/mail";

let mailer: ReturnType<typeof createSmtpMailer> | undefined;
try {
  readAuthConfig();
  const config = readMailConfig();
  if (config.driver !== "smtp")
    throw new Error(
      "Configure MAIL_DRIVER=smtp before checking the connection.",
    );
  mailer = createSmtpMailer(config);
  await mailer.verify();
  console.log(
    "SMTP connection, TLS and authentication verified. No email was sent.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Mail check failed.");
  process.exitCode = 1;
} finally {
  mailer?.close();
}
