import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createEmbeddedDatabase } from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "./seed";
import {
  getCheckoutQuote,
  createOrder,
  simulateOrder,
} from "../src/server/checkout/service";
import { createDemoProvider } from "../src/server/payments/provider";
import { renderLicensePdf } from "../src/server/documents/pdf";
import type { CurrentUser } from "../src/server/auth/session";

const db = await createEmbeddedDatabase();
try {
  await migrate(db);
  await seedDemo(db);
  const user: CurrentUser = {
    id: randomUUID(),
    email: "artist@example.test",
    name: "Демо Артист",
    role: "CUSTOMER",
  };
  await db.query("INSERT INTO users(id,email,artist_name) VALUES($1,$2,$3)", [
    user.id,
    user.email,
    user.name,
  ]);
  const directory = path.resolve("work/pdf-preview");
  await mkdir(directory, { recursive: true });
  for (const [kind, id, name] of [
    ["WAV", "10000000-0000-4000-8000-000000000001", "license-demo.pdf"],
    ["EXCLUSIVE", "10000000-0000-4000-8000-000000000002", "exclusive-demo.pdf"],
  ]) {
    const provider = createDemoProvider(db),
      quote = await getCheckoutQuote(user, id, kind, db);
    const order = await createOrder(
      user,
      {
        productId: id,
        kind,
        revision: quote.revision,
        accepted: true,
        requestKey: randomUUID(),
      },
      db,
      provider,
      "http://127.0.0.1:3000",
    );
    const paid = await simulateOrder(
      user,
      order.id,
      "succeeded",
      db,
      provider,
      "http://127.0.0.1:3000",
    );
    const bytes = await renderLicensePdf({
      id: randomUUID(),
      orderId: paid.id,
      paidAt: new Date(paid.paidAt!),
      snapshot: paid.snapshot,
    });
    await writeFile(path.join(directory, name), bytes);
    console.log(path.join(directory, name));
  }
} finally {
  await db.close();
}
