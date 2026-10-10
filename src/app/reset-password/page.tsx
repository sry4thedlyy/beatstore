import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
export const metadata = {
  title: "Новый пароль",
  referrer: "no-referrer" as const,
};
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string }>;
}) {
  const params = await searchParams;
  const token =
    !params.error &&
    typeof params.token === "string" &&
    /^[a-zA-Z0-9_-]{1,256}$/.test(params.token)
      ? params.token
      : undefined;
  return (
    <div className="auth-page">
      <Link href="/login" className="back-link">
        ← Назад ко входу
      </Link>
      <AuthForm mode="reset" token={token} />
    </div>
  );
}
