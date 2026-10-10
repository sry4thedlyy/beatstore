import { createAuth } from "../src/server/auth";
import { readAuthConfig } from "../src/server/auth/config";
import { openDatabase } from "../src/server/db/connection";

const db = await openDatabase();
try {
  const email = "demo@example.test";
  const { rows } = await db.query("SELECT id FROM users WHERE email = $1", [
    email,
  ]);
  if (rows.length)
    console.log(
      "Demo account already exists. Its password has not been changed.",
    );
  else {
    const password = "Beatstore-demo-2026";
    await createAuth(db, readAuthConfig()).api.signUpEmail({
      body: { name: "Demo Artist", email, password },
    });
    console.log(
      `Local demo account created.\nEmail: ${email}\nPassword: ${password}`,
    );
  }
} finally {
  await db.close();
}
