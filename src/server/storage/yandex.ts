import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  YANDEX_ENDPOINT,
  YANDEX_REGION,
  storageDriver,
  yandexConfig,
  type YandexStorageConfig,
} from "./config";

export interface ObjectReference {
  bucket: string;
  object_key: string;
}
export interface ObjectMetadata {
  size: number;
  checksum: string;
  etag: string;
  operation: string;
}
export interface StoredFile extends ObjectReference {
  size_bytes: string;
  checksum: string;
}
export class StorageError extends Error {
  constructor() {
    super("Object storage operation failed.");
    this.name = "StorageError";
  }
}
export class MissingObjectError extends StorageError {}
function missing(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    (error.$metadata as { httpStatusCode?: number })?.httpStatusCode === 404
  );
}
export class YandexStorage {
  private client: S3Client;
  constructor(
    readonly config: YandexStorageConfig,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        endpoint: YANDEX_ENDPOINT,
        region: YANDEX_REGION,
        forcePathStyle: true,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        maxAttempts: 1,
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        requestHandler: { connectionTimeout: 5000, requestTimeout: 900000 },
      });
  }
  reference(
    area: "uploads" | "documents" | "imports",
    basename: string,
  ): ObjectReference {
    if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(basename))
      throw new StorageError();
    return {
      bucket: this.config.bucket,
      object_key: `${this.config.prefix}${area}/${basename}`,
    };
  }
  private input(ref: ObjectReference) {
    if (
      ref.bucket !== this.config.bucket ||
      !ref.object_key.startsWith(this.config.prefix) ||
      !/^[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/.test(ref.object_key)
    )
      throw new StorageError();
    return { Bucket: ref.bucket, Key: ref.object_key };
  }
  async head(
    ref: ObjectReference,
    signal?: AbortSignal,
  ): Promise<ObjectMetadata> {
    const input = this.input(ref);
    try {
      const r = await this.client.send(new HeadObjectCommand(input), {
        abortSignal: signal,
      });
      if (
        !Number.isSafeInteger(r.ContentLength) ||
        !r.ETag ||
        !/^[a-f0-9]{64}$/.test(r.Metadata?.sha256 ?? "")
      )
        throw new StorageError();
      return {
        size: r.ContentLength!,
        etag: r.ETag,
        checksum: r.Metadata!.sha256,
        operation: r.Metadata?.operation ?? "",
      };
    } catch (e) {
      throw missing(e) ? new MissingObjectError() : new StorageError();
    }
  }
  async putBytes(
    ref: ObjectReference,
    bytes: Buffer,
    type: string,
    checksum: string,
    operation: string,
  ) {
    if (createHash("sha256").update(bytes).digest("hex") !== checksum)
      throw new StorageError();
    await this.put(
      ref,
      bytes,
      bytes.length,
      createHash("md5").update(bytes).digest("base64"),
      type,
      checksum,
      operation,
    );
  }
  async putFile(
    ref: ObjectReference,
    filename: string,
    size: number,
    type: string,
    checksum: string,
    operation: string,
  ) {
    const md5 = createHash("md5"),
      sha = createHash("sha256");
    let actual = 0;
    for await (const chunk of createReadStream(filename)) {
      md5.update(chunk);
      sha.update(chunk);
      actual += chunk.length;
    }
    if (actual !== size || sha.digest("hex") !== checksum)
      throw new StorageError();
    const stream = createReadStream(filename);
    try {
      await this.put(
        ref,
        stream,
        size,
        md5.digest("base64"),
        type,
        checksum,
        operation,
      );
    } finally {
      stream.destroy();
    }
  }
  private async put(
    ref: ObjectReference,
    body: Buffer | ReturnType<typeof createReadStream>,
    size: number,
    md5: string,
    type: string,
    checksum: string,
    operation: string,
  ) {
    const input = this.input(ref);
    try {
      await this.client.send(
        new PutObjectCommand({
          ...input,
          Body: body,
          ContentLength: size,
          ContentType: type,
          ContentMD5: md5,
          Metadata: { sha256: checksum, operation },
          StorageClass: "STANDARD",
          IfNoneMatch: "*",
        }),
      );
      const info = await this.head(ref);
      if (
        info.size !== size ||
        info.checksum !== checksum ||
        info.operation !== operation
      )
        throw new StorageError();
    } catch {
      throw new StorageError();
    }
  }
  async open(
    file: StoredFile,
    info: ObjectMetadata,
    range?: { start: number; end: number },
    signal?: AbortSignal,
  ) {
    const input = this.input(file);
    try {
      const r = await this.client.send(
        new GetObjectCommand({
          ...input,
          IfMatch: info.etag,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
        { abortSignal: signal },
      );
      const expected = range
        ? range.end - range.start + 1
        : Number(file.size_bytes);
      if (!r.Body) throw new StorageError();
      const stream = r.Body.transformToWebStream();
      if (
        r.ContentLength !== expected ||
        r.Metadata?.sha256 !== file.checksum ||
        (range &&
          r.ContentRange !==
            `bytes ${range.start}-${range.end}/${file.size_bytes}`)
      ) {
        await stream.cancel();
        throw new StorageError();
      }
      return stream;
    } catch (e) {
      throw missing(e) ? new MissingObjectError() : new StorageError();
    }
  }
  // Cleanup is limited to objects created by the same operation; collision targets are retained.
  async removeOwned(ref: ObjectReference, operation: string): Promise<boolean> {
    try {
      const info = await this.head(ref);
      if (info.operation !== operation) return true;
      await this.client.send(new DeleteObjectCommand(this.input(ref)));
      return true;
    } catch (e) {
      return e instanceof MissingObjectError;
    }
  }
  objectUrl(ref: ObjectReference) {
    this.input(ref);
    return `${YANDEX_ENDPOINT}/${ref.bucket}/${ref.object_key.split("/").map(encodeURIComponent).join("/")}`;
  }
  close() {
    this.client.destroy();
  }
}
let cached: { config: string; storage: YandexStorage } | undefined;
export function yandexStorage() {
  const config = yandexConfig(),
    key = JSON.stringify(config);
  if (!cached || cached.config !== key) {
    cached?.storage.close();
    cached = { config: key, storage: new YandexStorage(config) };
  }
  return cached.storage;
}
export function newFileStorage() {
  return storageDriver() === "yandex" ? yandexStorage() : null;
}
