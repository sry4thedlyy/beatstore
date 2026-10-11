import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../../src/server/db/connection";
import { migrate } from "../../src/server/db/migrate";
import { createAuth } from "../../src/server/auth";
import { readAuthConfig } from "../../src/server/auth/config";
import { seedDemo } from "../../scripts/seed";

const project = fileURLToPath(new URL("../../", import.meta.url));
const db = await openDatabase();
try {
  await migrate(db, path.join(project, "migrations"));
  await seedDemo(db);
  const auth = createAuth(db, readAuthConfig());
  for (const administrator of [false, true]) {
    const email = administrator ? "admin@example.test" : "demo@example.test";
    await auth.api.signUpEmail({
      body: {
        name: administrator ? "Demo Admin" : "Demo Artist",
        email,
        password: administrator
          ? "Beatstore-admin-2026"
          : "Beatstore-demo-2026",
      },
    });
    if (administrator)
      await db.query("UPDATE users SET role='ADMIN' WHERE email=$1", [email]);
  }
} finally {
  await db.close();
}
