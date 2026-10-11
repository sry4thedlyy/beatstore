import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

let content = "";
try {
  content = await readFile(".env.local", "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const env = parseEnv(content);
if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length < 32)
  throw new Error(
    "Existing BETTER_AUTH_SECRET is too short. Set at least 32 characters in .env.local.",
  );
const additions: string[] = [];
if (!env.BETTER_AUTH_SECRET)
  additions.push(`BETTER_AUTH_SECRET=${randomBytes(48).toString("base64url")}`);
if (!env.BETTER_AUTH_URL)
  additions.push("BETTER_AUTH_URL=http://127.0.0.1:3000");
if (!env.BACKUP_PASSPHRASE)
  additions.push(`BACKUP_PASSPHRASE=${randomBytes(48).toString("base64url")}`);
if (additions.length)
  await writeFile(
    ".env.local",
    `${content}${content && !content.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`,
    { mode: 0o600 },
  );
console.log(
  "Auth and backup secrets are ready in .env.local. Existing values are preserved; secrets are not printed.",
);
