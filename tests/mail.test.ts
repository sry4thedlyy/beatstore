import assert from "node:assert/strict";
import { test } from "node:test";
import { readAuthConfig } from "../src/server/auth/config";
import { readMailConfig } from "../src/server/auth/mail-config";
import { createSmtpMailer, type SmtpClient } from "../src/server/auth/mail";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

const settings = {
  MAIL_DRIVER: "smtp",
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "465",
  SMTP_USER: "sender@example.test",
  SMTP_PASSWORD: "private-test-password",
  SMTP_FROM: "sender@example.test",
  BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
  BETTER_AUTH_URL: "https://demo.example.test",
};

test("public origins require HTTPS and complete SMTP settings; local file mail remains available", () => {
  assert.equal(readAuthConfig(settings).baseURL, settings.BETTER_AUTH_URL);
  assert.throws(
    () =>
      readAuthConfig({
        ...settings,
        BETTER_AUTH_URL: "http://demo.example.test",
      }),
    /HTTPS/,
  );
  assert.throws(
    () => readAuthConfig({ ...settings, MAIL_DRIVER: "file" }),
    /loopback/,
  );
  assert.throws(
    () => readAuthConfig({ ...settings, SMTP_PASSWORD: "" }),
    /SMTP_PASSWORD/,
  );
  assert.throws(
    () => readMailConfig({ ...settings, SMTP_PORT: "25" }),
    /465|587/,
  );
  assert.throws(
    () =>
      readMailConfig({
        ...settings,
        SMTP_FROM: "a@example.test\r\nBcc: hidden@example.test",
      }),
    /single email/,
  );
  assert.throws(
    () => readMailConfig({ ...settings, SMTP_HOST: "smtp://user:pass@host" }),
    /SMTP_HOST/,
  );
  assert.throws(
    () => readMailConfig({ MAIL_DRIVER: "unknown" }),
    /MAIL_DRIVER/,
  );
  assert.deepEqual(readMailConfig({}), { driver: "file" });
});

test("SMTP uses verified TLS on 465 or required STARTTLS on 587, structured addresses and no protocol logs", async () => {
  for (const port of ["465", "587"]) {
    const config = readMailConfig({ ...settings, SMTP_PORT: port });
    assert.equal(config.driver, "smtp");
    if (config.driver !== "smtp") throw new Error("Expected SMTP");
    let options: SMTPTransport.Options | undefined;
    const messages: Parameters<SmtpClient["sendMail"]>[0][] = [];
    let checks = 0;
    const mailer = createSmtpMailer(config, (opts) => {
      options = opts;
      return {
        sendMail: async (mail) => {
          messages.push(mail);
          return { accepted: [mail.to.address], rejected: [] };
        },
        verify: async () => {
          checks++;
        },
        close: () => {},
      };
    });
    await mailer.verify();
    assert.equal(checks, 1);
    assert.equal(
      messages.length,
      0,
      "Connection check does not send a message",
    );
    const url = `${settings.BETTER_AUTH_URL}/api/auth/reset-password/private-token`;
    await mailer.send({ email: "artist@example.test", url });
    assert.equal(options?.secure, port === "465");
    assert.equal(options?.requireTLS, true);
    assert.equal(options?.tls?.rejectUnauthorized, true);
    assert.equal(options?.debug, false);
    assert.equal(options?.logger, false);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].to, { address: "artist@example.test" });
    assert.equal(messages[0].from.address, settings.SMTP_FROM);
    assert.match(messages[0].text, /30 минут/);
    assert(messages[0].text.includes(url));
  }
});

test("provider failures and recipient rejection expose no credentials or SMTP response", async () => {
  const config = readMailConfig(settings);
  if (config.driver !== "smtp") throw new Error("Expected SMTP");
  const secret =
    "SMTP authentication rejected private-test-password private-token artist@example.test";
  const mailer = createSmtpMailer(config, () => ({
    sendMail: async () => {
      throw new Error(secret);
    },
    verify: async () => {
      throw new Error(secret);
    },
    close: () => {},
  }));
  await assert.rejects(
    mailer.send({
      email: "artist@example.test",
      url: "https://demo.example.test/private-token",
    }),
    { message: "SMTP_DELIVERY_FAILED" },
  );
  await assert.rejects(mailer.verify(), { message: "SMTP_CONNECTION_FAILED" });
  const rejected = createSmtpMailer(config, () => ({
    sendMail: async () => ({ accepted: [], rejected: ["artist@example.test"] }),
    verify: async () => {},
    close: () => {},
  }));
  await assert.rejects(
    rejected.send({
      email: "artist@example.test",
      url: settings.BETTER_AUTH_URL,
    }),
    { message: "SMTP_DELIVERY_FAILED" },
  );
});
