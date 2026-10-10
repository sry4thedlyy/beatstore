import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  createEmbeddedDatabase,
  type Database,
} from "../src/server/db/connection";
import { migrate } from "../src/server/db/migrate";
import { seedDemo } from "../scripts/seed";
import { createAuth, type ShopAuth } from "../src/server/auth";
import { handleAuthRequest } from "../src/server/auth/handler";
import type { ResetMail } from "../src/server/auth/mail";
import type { CurrentUser } from "../src/server/auth/session";
import { getAccountCounts, getAdminOverview } from "../src/server/account";
import { safeReturnTo } from "../src/domain/auth";
import { readAuthConfig } from "../src/server/auth/config";

const config = {
  baseURL: "http://127.0.0.1:3999",
  secret: randomBytes(48).toString("base64url"),
};
const password = "local-demo-password-2026";
const newPassword = "new-local-password-2026";
const mails: ResetMail[] = [];
let db: Database;
let auth: ShopAuth;
before(async () => {
  db = await createEmbeddedDatabase();
  await migrate(db);
  await seedDemo(db);
  auth = createAuth(db, config, async (mail) => {
    mails.push(mail);
  });
});
beforeEach(async () => {
  await db.query("DELETE FROM auth_rate_limits");
  mails.length = 0;
});
after(async () => {
  await db?.close();
});

function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
function request(
  path: string,
  body?: Record<string, unknown>,
  sessionCookie?: string,
  extraHeaders?: Record<string, string>,
) {
  return handleAuthRequest(
    auth,
    new Request(`${config.baseURL}/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: config.baseURL,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(sessionCookie ? { cookie: sessionCookie } : {}),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}
async function register(email: string, fields: Record<string, unknown> = {}) {
  const response = await request("/sign-up/email", {
    email,
    name: "Demo Artist",
    password,
    ...fields,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const data = (await response.json()) as { user: CurrentUser };
  return { user: data.user, cookie: cookie(response), response };
}
async function session(sessionCookie: string) {
  const response = await request("/get-session", undefined, sessionCookie);
  assert.equal(response.status, 200);
  return (await response.json()) as {
    user: CurrentUser;
    session: { id: string };
  } | null;
}
function resetToken(mail: ResetMail) {
  return new URL(mail.url).pathname.split("/").at(-1)!;
}

test("registration normalizes email, preserves users' IDs, hashes passwords and ignores overposted roles", async () => {
  const result = await register("  Artist@Example.TEST ", {
    role: "ADMIN",
    name: "  Demo Artist  ",
  });
  assert.equal(result.user.role, "CUSTOMER");
  assert.equal(result.user.email, "artist@example.test");
  assert.equal(result.user.name, "Demo Artist");
  assert.match(result.user.id, /^[0-9a-f-]{36}$/);
  const { rows } = await db.query<{ password: string; user_id: string }>(
    "SELECT password,user_id FROM auth_accounts WHERE user_id = $1 AND provider_id = 'credential'",
    [result.user.id],
  );
  assert.equal(rows[0].user_id, result.user.id);
  assert.ok(rows[0].password.length > 50);
  assert.notEqual(rows[0].password, password);
  const headers = result.response.headers.getSetCookie().join(";");
  assert.match(headers, /HttpOnly/i);
  assert.match(headers, /SameSite=Lax/i);
  assert.match(result.response.headers.get("cache-control")!, /no-store/);
  assert.equal((await session(result.cookie))?.user.id, result.user.id);
  const duplicate = await request("/sign-up/email", {
    email: "ARTIST@example.test",
    name: "Other",
    password,
  });
  assert.equal(duplicate.status, 422);
  assert.equal(
    (
      await db.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM users WHERE email = 'artist@example.test'",
      )
    ).rows[0].count,
    1,
  );
  assert.equal(
    (await request("/update-user", { role: "ADMIN" }, result.cookie)).status,
    404,
  );
  assert.equal((await session(result.cookie))?.user.role, "CUSTOMER");
});

test("server validation rejects short passwords, blank artist names and oversized bodies", async () => {
  assert.equal(
    (
      await request("/sign-up/email", {
        email: "short@example.test",
        name: "Artist",
        password: "short",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/sign-up/email", {
        email: "blank@example.test",
        name: " ",
        password,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/sign-up/email", {
        email: "large@example.test",
        name: "x".repeat(9000),
        password,
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await db.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM users WHERE email IN ('short@example.test','blank@example.test','large@example.test')",
      )
    ).rows[0].count,
    0,
  );
});

test("wrong credentials, tampered cookies, expiry and logout never authenticate", async () => {
  const result = await register("sessions@example.test");
  const bad = await request("/sign-in/email", {
    email: result.user.email,
    password: "a-wrong-password",
  });
  const unknown = await request("/sign-in/email", {
    email: "unknown@example.test",
    password,
  });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await bad.json(), await unknown.json());
  assert.equal(await session("beatstore.session_token=forged"), null);
  const logout = await request("/sign-out", {}, result.cookie);
  assert.equal(logout.status, 200);
  assert.equal(await session(result.cookie), null);
  const login = await request("/sign-in/email", {
    email: result.user.email,
    password,
  });
  assert.equal(login.status, 200);
  const active = await session(cookie(login));
  assert.ok(active);
  await db.query(
    "UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE id = $1",
    [active.session.id],
  );
  assert.equal(await session(cookie(login)), null);
});

test("reset responses hide account existence; a successful single-use reset revokes every session", async () => {
  const result = await register("reset@example.test");
  const secondLogin = await request("/sign-in/email", {
    email: result.user.email,
    password,
  });
  const known = await request("/request-password-reset", {
    email: "RESET@example.test",
    redirectTo: "https://outside.example/steal",
  });
  const unknown = await request("/request-password-reset", {
    email: "missing@example.test",
  });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal(mails.length, 1);
  const token = resetToken(mails[0]);
  assert.equal(
    new URL(mails[0].url).searchParams.get("callbackURL"),
    "/reset-password",
  );
  const verification = (
    await db.query<{ identifier: string }>(
      "SELECT identifier FROM auth_verifications WHERE value = $1",
      [result.user.id],
    )
  ).rows[0];
  assert.ok(verification && !verification.identifier.includes(token));
  const callback = await handleAuthRequest(auth, new Request(mails[0].url));
  assert.equal(callback.status, 302);
  assert.equal(
    new URL(callback.headers.get("location")!).searchParams.get("token"),
    token,
  );
  assert.equal(
    (await request("/reset-password", { token, newPassword: "short" })).status,
    400,
  );
  assert.equal(
    (await request("/reset-password", { token, newPassword })).status,
    200,
  );
  assert.equal(await session(result.cookie), null);
  assert.equal(await session(cookie(secondLogin)), null);
  assert.equal(
    (await request("/sign-in/email", { email: result.user.email, password }))
      .status,
    401,
  );
  assert.equal(
    (
      await request("/sign-in/email", {
        email: result.user.email,
        password: newPassword,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/reset-password", { token, newPassword: password })).status,
    400,
  );
});

test("expired reset links fail and concurrent use changes the password only once", async () => {
  const expiredUser = await register("expired@example.test");
  await request("/request-password-reset", { email: expiredUser.user.email });
  const expired = mails[0];
  await db.query(
    "UPDATE auth_verifications SET expires_at = now() - interval '1 second' WHERE value = $1",
    [expiredUser.user.id],
  );
  const callback = await handleAuthRequest(auth, new Request(expired.url));
  assert.equal(
    new URL(callback.headers.get("location")!).searchParams.get("error"),
    "INVALID_TOKEN",
  );
  assert.equal(
    (
      await request("/reset-password", {
        token: resetToken(expired),
        newPassword,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/sign-in/email", {
        email: expiredUser.user.email,
        password,
      })
    ).status,
    200,
  );
  const concurrent = await register("concurrent@example.test");
  await request("/request-password-reset", { email: concurrent.user.email });
  const token = resetToken(mails.at(-1)!);
  const attempts = await Promise.all([
    request("/reset-password", { token, newPassword }),
    request("/reset-password", { token, newPassword: "another-new-password" }),
  ]);
  assert.deepEqual(
    attempts.map((response) => response.status).sort(),
    [200, 400],
  );
  assert.equal(await session(concurrent.cookie), null);
});

test("cross-site and missing-origin mutations are rejected; rate limits persist and resist forged forwarded IPs", async () => {
  assert.equal(
    (
      await request(
        "/sign-in/email",
        { email: "rate@example.test", password },
        undefined,
        { origin: "https://outside.example" },
      )
    ).status,
    403,
  );
  const missingOrigin = new Request(
    `${config.baseURL}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "csrf@example.test",
        password,
        name: "Artist",
      }),
    },
  );
  assert.equal((await handleAuthRequest(auth, missingOrigin)).status, 403);
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await request(
          "/sign-in/email",
          { email: "rate@example.test", password },
          undefined,
          { "x-forwarded-for": `198.51.100.${i + 1}` },
        )
      ).status,
      401,
    );
  const restartedAuth = createAuth(db, config, async () => {});
  const last = await handleAuthRequest(
    restartedAuth,
    new Request(`${config.baseURL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: config.baseURL,
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.1",
      },
      body: JSON.stringify({ email: "rate@example.test", password }),
    }),
  );
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("retry-after")) > 0);
  assert.equal((await request("/mail")).status, 404);
});

test("customer account counts are isolated and administrator roles are read from the database", async () => {
  const first = await register("first-customer@example.test");
  const second = await register("second-customer@example.test");
  const { rows } = await db.query<{
    id: string;
    product_id: string;
    base_price_kopecks: number;
  }>(
    "SELECT id, product_id, base_price_kopecks FROM offers WHERE kind = 'WAV' LIMIT 1",
  );
  const offer = rows[0];
  await db.query(
    `INSERT INTO orders (user_id,product_id,offer_id,purchase_kind,status,base_price_kopecks,discount_percent,total_kopecks,snapshot,expires_at)
    VALUES ($1,$2,$3,'WAV','AWAITING_PAYMENT',$4,0,$4,'{}',now() + interval '15 minutes')`,
    [first.user.id, offer.product_id, offer.id, offer.base_price_kopecks],
  );
  assert.deepEqual(await getAccountCounts(first.user, db), {
    purchases: 0,
    pending: 1,
  });
  assert.deepEqual(await getAccountCounts(second.user, db), {
    purchases: 0,
    pending: 0,
  });
  await assert.rejects(getAdminOverview(second.user, db), /Admin access/);
  await db.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [
    second.user.id,
  ]);
  const current = await session(second.cookie);
  assert.equal(current?.user.role, "ADMIN");
  assert.deepEqual(await getAdminOverview(current!.user, db), {
    products: 4,
    published: 4,
  });
  await db.query("UPDATE users SET role = 'CUSTOMER' WHERE id = $1", [
    second.user.id,
  ]);
  await assert.rejects(
    getAdminOverview((await session(second.cookie))!.user, db),
    /Admin access/,
  );
});

test("redirects allow only internal shop destinations; local secrets and mailbox configuration are required", () => {
  for (const input of [
    "https://outside.example",
    "//outside.example",
    "/\\outside.example",
    "/%2f%2foutside.example",
    "/login",
    "javascript:alert(1)",
    ["/account"],
  ])
    assert.equal(safeReturnTo(input), "/account");
  const product = "/products/10000000-0000-4000-8000-000000000001";
  assert.equal(
    safeReturnTo("/products/new?next=https://outside.example"),
    "/products/new",
  );
  assert.equal(safeReturnTo(`${product}/edit?license=WAV`), `${product}/edit`);
  assert.equal(safeReturnTo("/api/admin/products"), "/account");
  assert.equal(
    safeReturnTo(`${product}?license=WAV&next=https://outside.example`),
    `${product}?license=WAV`,
  );
  assert.throws(() => readAuthConfig({}), /BETTER_AUTH_SECRET/);
  assert.throws(
    () =>
      readAuthConfig({
        BETTER_AUTH_SECRET: config.secret,
        BETTER_AUTH_URL: "https://public.example",
      }),
    /local|loopback/,
  );
  assert.equal(
    readAuthConfig({ BETTER_AUTH_SECRET: config.secret }).baseURL,
    "http://127.0.0.1:3000",
  );
});

test("HTTPS sessions use Secure cookies", async () => {
  const secureBase = "https://localhost:3999";
  const secureAuth = createAuth(
    db,
    { ...config, baseURL: secureBase },
    async () => {},
  );
  const response = await handleAuthRequest(
    secureAuth,
    new Request(`${secureBase}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: secureBase, "content-type": "application/json" },
      body: JSON.stringify({
        email: "secure@example.test",
        name: "Artist",
        password,
      }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.getSetCookie().join(";"), /; Secure/i);
});
