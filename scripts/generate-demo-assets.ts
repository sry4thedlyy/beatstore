import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { Mp3Encoder } from "@breezystack/lamejs";
import { demoProducts, kitTerms } from "./demo-data";

export const assetDirectory = path.resolve(".data/demo-assets");

function coverSvg(product: (typeof demoProducts)[number]): string {
  const lines = Array.from({ length: 12 }, (_, index) => {
    const y = 270 + index * 46;
    return `<path d="M120 ${y} Q 390 ${y - 140} 600 ${y} T1080 ${y}" fill="none" stroke="${product.dark}" stroke-width="8" opacity="${0.25 + index / 18}"/>`;
  }).join("");
  const art =
    product.art === "orbit"
      ? `<circle cx="600" cy="560" r="345" fill="${product.dark}"/><circle cx="600" cy="560" r="220" fill="${product.color}"/><circle cx="600" cy="560" r="80" fill="${product.dark}"/><ellipse cx="600" cy="560" rx="460" ry="105" fill="none" stroke="#edece4" stroke-width="10" transform="rotate(-30 600 560)"/>`
      : product.art === "stairs"
        ? Array.from(
            { length: 6 },
            (_, i) =>
              `<rect x="${150 + i * 125}" y="${750 - i * 100}" width="130" height="${140 + i * 100}" fill="${product.dark}" opacity="${0.4 + i * 0.1}"/>`,
          ).join("")
        : product.art === "grid"
          ? Array.from(
              { length: 16 },
              (_, i) =>
                `<circle cx="${260 + (i % 4) * 225}" cy="${265 + Math.floor(i / 4) * 180}" r="${35 + (i % 3) * 16}" fill="${product.dark}" opacity="${0.3 + (i % 4) * 0.2}"/>`,
            ).join("")
          : lines;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><rect width="1200" height="1200" fill="${product.color}"/>${art}<text x="80" y="105" fill="${product.dark}" font-family="sans-serif" font-size="28" letter-spacing="6">BEATSTORE / 0${demoProducts.indexOf(product) + 1}</text><text x="80" y="1060" fill="${product.dark}" font-family="sans-serif" font-size="62" font-weight="700" letter-spacing="-2">${product.label}</text><text x="84" y="1120" fill="${product.dark}" font-family="sans-serif" font-size="24" letter-spacing="4">${product.type === "BEAT" ? "INSTRUMENTAL" : "DRUM COLLECTION"} / DEMO</text></svg>`;
}

function audio(frequency: number, bpm: number): Int16Array {
  const sampleRate = 44100;
  const length = 16 * sampleRate;
  const samples = new Int16Array(length);
  const beat = 60 / bpm;
  let noiseState = 123456;
  for (let index = 0; index < length; index++) {
    const t = index / sampleRate;
    const pulse = t % beat;
    const hat = t % (beat / 2);
    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) >>> 0;
    const noise = (noiseState / 0xffffffff) * 2 - 1;
    const chord =
      [1, 1.189207, 1.498307].reduce(
        (sum, ratio) => sum + Math.sin(2 * Math.PI * frequency * ratio * t),
        0,
      ) * 0.035;
    const kick =
      Math.sin(2 * Math.PI * (48 * pulse + 4 * (1 - Math.exp(-pulse * 35)))) *
      Math.exp(-pulse * 18) *
      0.4;
    const bass = Math.sin(((2 * Math.PI * frequency) / 4) * t) * 0.13;
    const fade = Math.min(t / 0.2, (16 - t) / 0.4, 1);
    samples[index] = Math.round(
      (chord + kick + bass + noise * Math.exp(-hat * 160) * 0.1) * fade * 30000,
    );
  }
  return samples;
}

function wav(samples: Int16Array): Buffer {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(88200, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) =>
    bytes.writeInt16LE(sample, 44 + index * 2),
  );
  return bytes;
}

// Store-only ZIP: small deterministic fixtures, no archive library needed.
export function zip(entries: { name: string; data: Buffer }[]): Buffer {
  function crc32(bytes: Buffer) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  const body: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(entry.data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    body.push(header, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += header.length + name.length + entry.data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, central, end]);
}

async function createIfMissing(
  key: string,
  make: () => Buffer | Promise<Buffer>,
) {
  const filename = path.join(assetDirectory, key);
  if (existsSync(filename)) return;
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, await make());
}

export async function generateDemoAssets() {
  for (const product of demoProducts) {
    const image = Buffer.from(coverSvg(product));
    await createIfMissing(`${product.slug}/cover.jpg`, () =>
      sharp(image).jpeg({ quality: 88 }).toBuffer(),
    );
    await createIfMissing(`${product.slug}/thumbnail.jpg`, () =>
      sharp(image).resize(480, 480).jpeg({ quality: 85 }).toBuffer(),
    );
    const samples = audio(product.frequency, product.bpm ?? 100);
    await createIfMissing(`${product.slug}/preview.mp3`, () => {
      const encoder = new Mp3Encoder(1, 44100, 128);
      const chunks: Buffer[] = [];
      for (let index = 0; index < samples.length; index += 1152)
        chunks.push(
          Buffer.from(
            encoder.encodeBuffer(samples.subarray(index, index + 1152)),
          ),
        );
      chunks.push(Buffer.from(encoder.flush()));
      return Buffer.concat(chunks);
    });
    if (product.type === "BEAT") {
      await createIfMissing(`${product.slug}/beat.wav`, () => wav(samples));
      await createIfMissing(`${product.slug}/stems.zip`, () =>
        zip([
          { name: "DEMO.wav", data: wav(samples) },
          {
            name: "README.txt",
            data: Buffer.from(
              "DEMO: synthetic audio fixture, not actual stems.",
            ),
          },
        ]),
      );
      await createIfMissing(`${product.slug}/project.zip`, () =>
        zip([
          {
            name: "README.txt",
            data: Buffer.from(
              "DEMO placeholder. No FL Studio project in this fixture. Replace with an actual FLP project before implementing delivery.",
            ),
          },
        ]),
      );
    } else {
      await createIfMissing(`${product.slug}/drumkit.zip`, () =>
        zip([
          { name: "USAGE.txt", data: Buffer.from(kitTerms) },
          { name: "DEMO.wav", data: wav(samples.slice(0, 44100)) },
        ]),
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await generateDemoAssets();
  console.log(
    "Demo covers, MP3 previews and private fixtures generated in .data/demo-assets.",
  );
}
