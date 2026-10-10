import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getAuth } from "./index";
import { authLink } from "../../domain/auth";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: "CUSTOMER" | "ADMIN";
}
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const requestHeaders = await headers();
  if (!requestHeaders.get("cookie")?.includes("beatstore.session_token="))
    return null;
  const session = await (
    await getAuth()
  ).api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session) return null;
  const { id, email, name, role } = session.user;
  return { id, email, name, role: role === "ADMIN" ? "ADMIN" : "CUSTOMER" };
});

export async function requireUser(returnTo = "/account"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(authLink("login", returnTo));
  return user;
}

export async function requireAdmin(
  returnTo = "/account",
): Promise<CurrentUser> {
  const user = await requireUser(returnTo);
  if (user.role !== "ADMIN") notFound();
  return user;
}
