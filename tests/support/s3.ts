import { createServer, type IncomingHttpHeaders } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { S3Client } from "@aws-sdk/client-s3";
import { YandexStorage } from "../../src/server/storage/yandex";

export interface TestObject {
  bytes: Buffer;
  type: string;
  checksum: string;
  operation: string;
  etag: string;
}
export async function testStorage() {
  const objects = new Map<string, TestObject>();
  const requests: {
    method: string;
    key: string;
    headers: IncomingHttpHeaders;
  }[] = [];
  const faults = {
    put: false,
    afterPut: false,
    delete: false,
    head: false,
    ignoreRange: false,
  };
  let afterPut: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"),
      key = decodeURIComponent(url.pathname).slice("/beatstore-test/".length);
    requests.push({ method: req.method!, key, headers: req.headers });
    const error = (status: number, code: string) => {
      res.writeHead(status, { "Content-Type": "application/xml" });
      res.end(
        `<Error><Code>${code}</Code><Message>Test storage failure</Message></Error>`,
      );
    };
    try {
      if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) {
        error(403, "AccessDenied");
        return;
      }
      if (req.method === "PUT") {
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(part);
        const bytes = Buffer.concat(parts);
        if (faults.put) {
          error(503, "ServiceUnavailable");
          return;
        }
        if (objects.has(key) && req.headers["if-none-match"] === "*") {
          error(412, "PreconditionFailed");
          return;
        }
        if (
          Number(req.headers["content-length"]) !== bytes.length ||
          req.headers["content-md5"] !==
            createHash("md5").update(bytes).digest("base64")
        ) {
          error(400, "BadDigest");
          return;
        }
        const obj = {
          bytes,
          type: String(req.headers["content-type"]),
          checksum: String(req.headers["x-amz-meta-sha256"]),
          operation: String(req.headers["x-amz-meta-operation"]),
          etag: `"${createHash("md5").update(bytes).digest("hex")}"`,
        };
        objects.set(key, obj);
        await afterPut?.();
        if (faults.afterPut) {
          error(503, "ServiceUnavailable");
          return;
        }
        res.writeHead(200, { ETag: obj.etag });
        res.end();
        return;
      }
      const obj = objects.get(key);
      if (req.method === "DELETE") {
        if (faults.delete) {
          error(503, "ServiceUnavailable");
          return;
        }
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      if (!obj) {
        error(404, "NoSuchKey");
        return;
      }
      if (faults.head && req.method === "HEAD") {
        error(503, "ServiceUnavailable");
        return;
      }
      if (req.headers["if-match"] && req.headers["if-match"] !== obj.etag) {
        error(412, "PreconditionFailed");
        return;
      }
      const match =
        !faults.ignoreRange && req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      const start = match ? Number(match[1]) : 0,
        end = match ? Number(match[2]) : obj.bytes.length - 1;
      const bytes = obj.bytes.subarray(start, end + 1);
      res.writeHead(match ? 206 : 200, {
        "Content-Length": bytes.length,
        "Content-Type": obj.type,
        ETag: obj.etag,
        "x-amz-meta-sha256": obj.checksum,
        "x-amz-meta-operation": obj.operation,
        ...(match
          ? { "Content-Range": `bytes ${start}-${end}/${obj.bytes.length}` }
          : {}),
      });
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch {
      if (!res.headersSent) error(500, "InternalError");
      else res.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a loopback address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const config = {
    bucket: "beatstore-test",
    prefix: "beatstore/",
    accessKeyId: "TEST-ACCESS",
    secretAccessKey: "TEST-SECRET",
  };
  const client = new S3Client({
    endpoint,
    region: "ru-central1",
    forcePathStyle: true,
    credentials: config,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 1000, requestTimeout: 5000 },
  });
  const cloud = new YandexStorage(config, client);
  return {
    cloud,
    endpoint,
    objects,
    requests,
    faults,
    setAfterPut: (callback?: () => Promise<void>) => {
      afterPut = callback;
    },
    close: async () => {
      cloud.close();
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}
