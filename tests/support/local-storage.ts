// Test processes must never inherit access to a real storage account.
process.env.STORAGE_DRIVER = "local";
process.env.MAIL_DRIVER = "file";
for (const key of [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM",
])
  delete process.env[key];
delete process.env.YC_STORAGE_BUCKET;
delete process.env.YC_STORAGE_PREFIX;
delete process.env.YC_STORAGE_ACCESS_KEY_ID;
delete process.env.YC_STORAGE_SECRET_ACCESS_KEY;
export {};
