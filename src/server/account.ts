import "server-only";
import { getDatabase, type Database } from "./db/connection";
import type { CurrentUser } from "./auth/session";

export async function getAccountCounts(
  user: CurrentUser,
  connection?: Database,
) {
  const db = connection ?? (await getDatabase());
  const { rows } = await db.query<{ purchases: number; pending: number }>(
    `SELECT
    count(*) FILTER (WHERE status IN ('PAID','REFUNDED'))::integer AS purchases,
    count(*) FILTER (WHERE status = 'AWAITING_PAYMENT')::integer AS pending
    FROM orders WHERE user_id = $1`,
    [user.id],
  );
  return rows[0];
}

export async function getAdminOverview(
  user: CurrentUser,
  connection?: Database,
) {
  if (user.role !== "ADMIN") throw new Error("Admin access required");
  const db = connection ?? (await getDatabase());
  const { rows } = await db.query<{
    products: number;
    published: number;
  }>(`SELECT
    count(*)::integer AS products, count(*) FILTER (WHERE status = 'PUBLISHED')::integer AS published FROM products`);
  return rows[0];
}
