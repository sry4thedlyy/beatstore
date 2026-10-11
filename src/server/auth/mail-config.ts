export type MailConfig =
  | { driver: "file" }
  | {
      driver: "smtp";
      host: string;
      port: 465 | 587;
      user: string;
      password: string;
      from: string;
    };

export function isLoopback(hostname: string) {
  return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
}

export function readMailConfig(
  env: Record<string, string | undefined> = process.env,
): MailConfig {
  const driver = env.MAIL_DRIVER ?? "file";
  if (driver === "file") return { driver };
  if (driver !== "smtp") throw new Error("Use MAIL_DRIVER=file or smtp.");
  const host = env.SMTP_HOST?.trim();
  const port = Number(env.SMTP_PORT ?? "465");
  const user = env.SMTP_USER?.trim();
  const password = env.SMTP_PASSWORD;
  const from = env.SMTP_FROM?.trim();
  if (!host || !/^[a-zA-Z0-9.-]+$/.test(host))
    throw new Error("Set a valid SMTP_HOST.");
  if (port !== 465 && port !== 587)
    throw new Error("SMTP_PORT must be 465 (TLS) or 587 (STARTTLS).");
  if (!user || /[\r\n]/.test(user) || !password)
    throw new Error("Set SMTP_USER and SMTP_PASSWORD.");
  // One mailbox only: display names, multiple recipients and header injection are rejected.
  if (!from || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(from))
    throw new Error("SMTP_FROM must be a single email address.");
  return { driver, host, port, user, password, from };
}
