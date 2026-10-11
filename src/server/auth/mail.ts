import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { readMailConfig, type MailConfig } from "./mail-config";

export interface ResetMail {
  email: string;
  url: string;
}

function resetText(url: string) {
  return `Для смены пароля открой ссылку. Она действует 30 минут и используется один раз.\n\n${url}\n\nЕсли ты не запрашивал смену пароля, просто проигнорируй письмо.`;
}

export async function saveResetMail({ email, url }: ResetMail): Promise<void> {
  const directory = path.resolve(/*turbopackIgnore: true*/ ".data/mail");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(directory, `${Date.now()}-${randomUUID()}.json`),
    JSON.stringify(
      {
        to: email,
        subject: "Beatstore — восстановление пароля",
        createdAt: new Date().toISOString(),
        text: resetText(url),
        url,
      },
      null,
      2,
    ),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

export interface SmtpClient {
  sendMail: (mail: {
    from: { name: string; address: string };
    to: { address: string };
    subject: string;
    text: string;
  }) => Promise<{ accepted: unknown[]; rejected: unknown[] }>;
  verify: () => Promise<unknown>;
  close: () => void;
}

export function createSmtpMailer(
  config: Extract<MailConfig, { driver: "smtp" }>,
  connect: (options: SMTPTransport.Options) => SmtpClient = (options) =>
    nodemailer.createTransport(
      options,
    ) as Transporter<SMTPTransport.SentMessageInfo>,
) {
  const client = connect({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: true,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    dnsTimeout: 10000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  return {
    async send({ email, url }: ResetMail) {
      try {
        const result = await client.sendMail({
          from: { name: "Beatstore", address: config.from },
          to: { address: email },
          subject: "Beatstore — восстановление пароля",
          text: resetText(url),
        });
        if (result.accepted.length !== 1 || result.rejected.length)
          throw new Error("Recipient rejected");
      } catch {
        // Provider responses can contain mailbox names, tokens and credentials.
        throw new Error("SMTP_DELIVERY_FAILED");
      }
    },
    async verify() {
      try {
        await client.verify();
      } catch {
        throw new Error("SMTP_CONNECTION_FAILED");
      }
    },
    close: () => client.close(),
  };
}

let smtp: ReturnType<typeof createSmtpMailer> | undefined;
export async function sendResetMail(mail: ResetMail) {
  const config = readMailConfig();
  if (config.driver === "file") return saveResetMail(mail);
  smtp ??= createSmtpMailer(config);
  await smtp.send(mail);
}
