export const YANDEX_ENDPOINT = "https://storage.yandexcloud.net";
export const YANDEX_REGION = "ru-central1";
export const LOCAL_BUCKETS = ["local-demo", "local-upload", "local-document"];
export interface YandexStorageConfig {
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export function storageDriver(
  env: Record<string, string | undefined> = process.env,
) {
  const driver = env.STORAGE_DRIVER ?? "local";
  if (driver !== "local" && driver !== "yandex")
    throw new Error("STORAGE_DRIVER must be local or yandex.");
  return driver;
}
export function yandexConfig(
  env: Record<string, string | undefined> = process.env,
): YandexStorageConfig {
  const bucket = env.YC_STORAGE_BUCKET ?? "";
  const prefix =
    (env.YC_STORAGE_PREFIX ?? "beatstore").replace(/\/$/, "") + "/";
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes("..") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(bucket) ||
    LOCAL_BUCKETS.includes(bucket)
  )
    throw new Error("YC_STORAGE_BUCKET must be a valid dedicated bucket name.");
  if (
    prefix.length > 128 ||
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/$/.test(prefix)
  )
    throw new Error("YC_STORAGE_PREFIX must contain safe path segments.");
  const accessKeyId = env.YC_STORAGE_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.YC_STORAGE_SECRET_ACCESS_KEY ?? "";
  if (
    !accessKeyId ||
    !secretAccessKey ||
    /\s/.test(accessKeyId + secretAccessKey)
  )
    throw new Error(
      "Set the Yandex storage static key in the local environment.",
    );
  return { bucket, prefix, accessKeyId, secretAccessKey };
}
