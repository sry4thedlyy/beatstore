import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { crc32 } from "node:zlib";
import { performance } from "node:perf_hooks";
import path from "node:path";

const MiB = 1024 * 1024;
const group = "/sys/fs/cgroup";
async function counter(file: string) {
  const value = Number((await readFile(path.join(group, file), "utf8")).trim());
  assert(
    Number.isFinite(value),
    `Missing finite cgroup limit/counter: ${file}`,
  );
  return value;
}
async function fields(file: string) {
  return Object.fromEntries(
    (await readFile(path.join(group, file), "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const [key, value] = line.trim().split(/\s+/);
        return [key, Number(value)];
      }),
  );
}

export async function capacityMonitor() {
  assert.equal(
    process.platform,
    "linux",
    "Capacity check requires a Linux cgroup v2 container",
  );
  const limit = await counter("memory.max");
  assert.equal(limit, 768 * MiB, "Use --memory=768m");
  assert.equal(
    await counter("memory.swap.max"),
    0,
    "Use --memory-swap=768m (no swap)",
  );
  const [quota, period] = (await readFile(path.join(group, "cpu.max"), "utf8"))
    .trim()
    .split(/\s+/)
    .map(Number);
  assert.equal(quota / period, 1, "Use --cpus=1");
  const initialEvents = await fields("memory.events");
  let stopped = false,
    failure: unknown,
    workingPeak = 0;
  const sample = (async () => {
    try {
      while (!stopped) {
        const memory = await fields("memory.stat");
        // Shared PostgreSQL pages count once; file cache is reported separately.
        workingPeak = Math.max(
          workingPeak,
          memory.anon + memory.shmem + memory.kernel,
        );
        await delay(100);
      }
    } catch (error) {
      failure = error;
    }
  })();
  return {
    async finish() {
      stopped = true;
      await sample;
      if (failure) throw failure;
      const events = await fields("memory.events");
      const result = {
        limitMiB: limit / MiB,
        peakIncludingCacheMiB: Math.round((await counter("memory.peak")) / MiB),
        sampledAnonSharedKernelPeakMiB: Math.round(workingPeak / MiB),
        oom: events.oom - initialEvents.oom,
        oomKills: events.oom_kill - initialEvents.oom_kill,
      };
      console.log("CAPACITY_MEMORY", JSON.stringify(result));
      assert.equal(result.oom, 0, "Memory exhaustion occurred");
      assert.equal(
        result.oomKills,
        0,
        "A process was killed for lack of memory",
      );
      // Keep at least 15% process-memory headroom within the application budget.
      assert(
        workingPeak < limit * 0.85,
        "Insufficient process-memory headroom",
      );
    },
  };
}

// Five visitors, at most four requests/sec each. HTTP bodies are always drained.
export function capacityTraffic(
  origin: string,
  preview: string,
  cover: string,
) {
  let stopped = false;
  const latency: number[] = [];
  const failures: string[] = [];
  const workers = Array.from({ length: 5 }, (_, worker) =>
    (async () => {
      let iteration = worker;
      while (!stopped) {
        const route = ["/", "/?q=Dust", preview, cover][iteration++ % 4];
        const start = performance.now();
        try {
          const response = await fetch(new URL(route, origin), {
            signal: AbortSignal.timeout(10000),
          });
          await response.arrayBuffer();
          if (response.status !== 200) failures.push(`HTTP ${response.status}`);
          latency.push(performance.now() - start);
        } catch {
          failures.push("Request failed or timed out");
        }
        await delay(250);
      }
    })(),
  );
  return {
    async finish() {
      stopped = true;
      await Promise.all(workers);
      latency.sort((a, b) => a - b);
      const p95 = latency[Math.ceil(latency.length * 0.95) - 1] ?? Infinity;
      console.log(
        "CAPACITY_TRAFFIC",
        JSON.stringify({
          visitors: 5,
          requests: latency.length,
          failures: failures.length,
          p95Ms: Math.round(p95),
        }),
      );
      assert.equal(failures.length, 0, failures[0]);
      assert(latency.length >= 100, "Capacity scenario was too short");
      assert(
        p95 < 2000,
        "95% of local responses must complete within two seconds",
      );
    },
  };
}

// Store-only fixture at the exact upload boundary. Fixed-size chunks avoid a
// 500 MiB client buffer that would distort the server's memory measurement.
export async function capacityZip(root: string) {
  const filename = path.join(root, "capacity.zip");
  const name = Buffer.from("USAGE.txt");
  const size = 500 * MiB;
  const payloadSize = size - (30 + name.length + 46 + name.length + 22);
  const chunk = Buffer.alloc(MiB, 0x20);
  let crc = 0;
  for (let offset = 0; offset < payloadSize; offset += chunk.length)
    crc = crc32(
      chunk.subarray(0, Math.min(chunk.length, payloadSize - offset)),
      crc,
    );
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(33, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payloadSize, 18);
  local.writeUInt32LE(payloadSize, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(33, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payloadSize, 20);
  central.writeUInt32LE(payloadSize, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + payloadSize, 16);
  const hash = createHash("sha256");
  const file = await open(filename, "wx", 0o600);
  async function write(bytes: Buffer) {
    hash.update(bytes);
    let offset = 0;
    while (offset < bytes.length)
      offset += (await file.write(bytes, offset)).bytesWritten;
  }
  try {
    await write(local);
    await write(name);
    for (let offset = 0; offset < payloadSize; offset += chunk.length)
      await write(
        chunk.subarray(0, Math.min(chunk.length, payloadSize - offset)),
      );
    await write(central);
    await write(name);
    await write(end);
  } finally {
    await file.close();
  }
  return {
    filename,
    size,
    sha256: hash.digest("hex"),
    stream: () => createReadStream(filename),
  };
}

export async function verifyCapacityDownload(
  response: Response,
  expected: Awaited<ReturnType<typeof capacityZip>>,
) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/zip");
  assert(response.body);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  assert.equal(bytes, expected.size);
  assert.equal(hash.digest("hex"), expected.sha256);
  console.log(
    "PASS: streamed 500 MiB ZIP upload, purchase and exact download checksum",
  );
}
