import { openDatabase } from "../src/server/db/connection";

const email = process.argv[2]?.trim().toLowerCase();
if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  throw new Error(
    "Use npm run account:admin -- email@example.ru with the app stopped.",
  );
const db = await openDatabase();
try {
  const { rows } = await db.query<{ id: string }>(
    "UPDATE users SET role = 'ADMIN', updated_at = now() WHERE email = $1 RETURNING id",
    [email],
  );
  if (!rows.length) throw new Error("Register this account first.");
  console.log("Administrator role assigned to the registered account.");
} finally {
  await db.close();
}
