import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(".data/mail");
const recipient = process.argv[2]?.trim().toLowerCase();
let files: string[] = [];
try {
  files = (await readdir(directory))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
let displayed = 0;
for (const file of files) {
  const mail = JSON.parse(
    await readFile(path.join(directory, file), "utf8"),
  ) as { to: string; createdAt: string; subject: string; text: string };
  if (recipient && mail.to !== recipient) continue;
  console.log(
    `${mail.createdAt}\nКому: ${mail.to}\n${mail.subject}\n${mail.text}\n`,
  );
  if (++displayed === 5) break;
}
if (!displayed) console.log("Локальных писем пока нет.");
