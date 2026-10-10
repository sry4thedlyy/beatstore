import { openDatabase } from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "./seed";

const command = process.argv[2];
if (!["migrate", "seed", "setup"].includes(command))
  throw new Error("Use migrate, seed or setup");
const db = await openDatabase();
try {
  if (command !== "seed") await migrate(db);
  if (command !== "migrate") await seedDemo(db);
  console.log(`Database ${command} complete.`);
} finally {
  await db.close();
}
