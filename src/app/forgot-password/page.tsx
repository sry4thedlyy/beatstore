import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
export const metadata = { title: "Восстановление пароля" };
export default function ForgotPasswordPage() {
  return (
    <div className="auth-page">
      <Link href="/login" className="back-link">
        ← Назад ко входу
      </Link>
      <AuthForm mode="forgot" />
    </div>
  );
}
