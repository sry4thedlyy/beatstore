import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { safeReturnTo } from "@/domain/auth";
import { getCurrentUser } from "@/server/auth/session";

export const metadata = { title: "Регистрация" };
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const returnTo = safeReturnTo((await searchParams).next);
  if (await getCurrentUser()) redirect(returnTo);
  return (
    <div className="auth-page">
      <Link href="/" className="back-link">
        ← Назад в каталог
      </Link>
      <AuthForm mode="register" returnTo={returnTo} />
    </div>
  );
}
