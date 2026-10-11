// Test processes must never inherit access to a real storage account.
process.env.STORAGE_DRIVER = "local";
delete process.env.YC_STORAGE_BUCKET;
delete process.env.YC_STORAGE_PREFIX;
delete process.env.YC_STORAGE_ACCESS_KEY_ID;
delete process.env.YC_STORAGE_SECRET_ACCESS_KEY;
export {};
