import { createAuth } from "../src/server/auth";
import { readAuthConfig } from "../src/server/auth/config";
import { openDatabase } from "../src/server/db/connection";

const db = await openDatabase();
try {
  const config = readAuthConfig();
  const administrator = process.argv.includes("--admin");
  const email = administrator ? "admin@example.test" : "demo@example.test";
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM users WHERE email = $1",
    [email],
  );
  if (rows.length)
    console.log(
      "Demo account already exists. Its password has not been changed.",
    );
  else {
    const password = administrator
      ? "Beatstore-admin-2026"
      : "Beatstore-demo-2026";
    await createAuth(db, config).api.signUpEmail({
      body: {
        name: administrator ? "Demo Admin" : "Demo Artist",
        email,
        password,
      },
    });
    console.log(
      `Local demo account created.\nEmail: ${email}\nPassword: ${password}`,
    );
  }
  if (administrator) {
    await db.query(
      "UPDATE users SET role='ADMIN',updated_at=now() WHERE email=$1",
      [email],
    );
    console.log("Local demonstration administrator is ready.");
  }
} finally {
  await db.close();
}
