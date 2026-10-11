import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAuth } from "../src/server/auth";
import { readAuthConfig } from "../src/server/auth/config";
import { openDatabase } from "../src/server/db/connection";

const email = process.argv[2]?.trim().toLowerCase();
if (
  !email ||
  !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email) ||
  email.length > 254
)
  throw new Error(
    "Use account:owner -- <owner email> while the application is stopped.",
  );
if (process.env.DB_DRIVER !== "postgres")
  throw new Error("Public owner setup requires DB_DRIVER=postgres.");
const db = await openDatabase();
try {
  const config = readAuthConfig();
  const existing = await db.query<{ role: string }>(
    "SELECT role FROM users WHERE email=$1",
    [email],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].role !== "ADMIN")
      throw new Error(
        "This email already belongs to a customer. Assign the owner role separately; its password will be preserved.",
      );
    console.log("Owner already exists. Credentials were preserved.");
  } else {
    const password = randomBytes(24).toString("base64url");
    const directory = path.resolve(".data/owner-access");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Save before creation so a write failure cannot leave an inaccessible owner.
    const file = path.join(
      directory,
      `owner-${Date.now()}-${randomBytes(8).toString("hex")}.json`,
    );
    await writeFile(file, JSON.stringify({ email, password }, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    const result = await createAuth(db, config).api.signUpEmail({
      body: { name: "Автор", email, password },
    });
    await db.query(
      "UPDATE users SET role='ADMIN',updated_at=now() WHERE id=$1",
      [result.user.id],
    );
    console.log(
      `Owner created. Read its private credentials file locally: ${file}`,
    );
  }
} finally {
  await db.close();
}
