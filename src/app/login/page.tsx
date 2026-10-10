import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { safeReturnTo } from "@/domain/auth";
import { getCurrentUser } from "@/server/auth/session";

export const metadata = { title: "Вход" };
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; reset?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.next);
  if (await getCurrentUser()) redirect(returnTo);
  return (
    <div className="auth-page">
      <Link href="/" className="back-link">
        ← Назад в каталог
      </Link>
      <AuthForm
        mode="login"
        returnTo={returnTo}
        resetComplete={params.reset === "success"}
      />
    </div>
  );
}
