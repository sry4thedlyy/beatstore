import "server-only";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth/minimal";
import { APIError } from "better-auth/api";
import { after } from "next/server";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../../domain/auth";
import { getDatabase, type Database } from "../db/connection";
import { readAuthConfig, type AuthConfig } from "./config";
import { sendResetMail, type ResetMail } from "./mail";
import * as schema from "./schema";

export function createAuth(
  db: Database,
  config: AuthConfig,
  deliver: (mail: ResetMail) => Promise<void> = sendResetMail,
  schedule?: (task: () => Promise<void>) => void,
) {
  return betterAuth({
    appName: "Beatstore",
    baseURL: config.baseURL,
    secret: config.secret,
    database: drizzleAdapter(db.authStore, {
      provider: "pg",
      schema,
      transaction: true,
    }),
    trustedOrigins: [config.baseURL],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      resetPasswordTokenExpiresIn: 30 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        const send = async () => {
          try {
            await deliver({ email: user.email, url });
          } catch {
            // Keep the same HTTP response for known and unknown accounts even on mail failure.
            console.error("Password reset email could not be delivered.");
          }
        };
        if (schedule) schedule(send);
        else await send();
      },
    },
    user: {
      additionalFields: {
        role: {
          type: ["CUSTOMER", "ADMIN"],
          input: false,
          defaultValue: "CUSTOMER",
          required: true,
        },
      },
    },
    session: {
      expiresIn: 7 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      cookieCache: { enabled: false },
    },
    verification: { storeIdentifier: "hashed" },
    advanced: {
      cookiePrefix: "beatstore",
      useSecureCookies: config.baseURL.startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      database: { generateId: () => randomUUID() },
      // A shared local bucket cannot be bypassed by spoofing forwarded-IP headers.
      ipAddress: { ipAddressHeaders: [] },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 8 },
        "/sign-up/email": { window: 300, max: 5 },
        "/request-password-reset": { window: 300, max: 3 },
        "/reset-password": { window: 300, max: 5 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const name = user.name.trim();
            if (!name || name.length > 80)
              throw new APIError("BAD_REQUEST", {
                code: "INVALID_NAME",
                message: "Invalid artist name",
              });
            return {
              data: {
                ...user,
                name,
                email: user.email.trim().toLowerCase(),
                role: "CUSTOMER",
              },
            };
          },
        },
      },
    },
    logger: { level: "error" },
  });
}

export type ShopAuth = ReturnType<typeof createAuth>;
let auth: Promise<ShopAuth> | undefined;
export function getAuth(): Promise<ShopAuth> {
  auth ??= getDatabase()
    .then((db) => createAuth(db, readAuthConfig(), sendResetMail, after))
    .catch((error: unknown) => {
      auth = undefined;
      throw error;
    });
  return auth;
}
