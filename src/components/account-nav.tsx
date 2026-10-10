"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { authLink } from "@/domain/auth";
import { authClient } from "./auth-client";
import { Icon } from "./icons";

export function AccountNav({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname();
  return (
    <Link
      className="account-link"
      aria-label={signedIn ? "Личный кабинет" : "Войти"}
      title={signedIn ? "Личный кабинет" : "Войти"}
      href={
        signedIn
          ? "/account"
          : authLink(
              "login",
              pathname.startsWith("/products/") ? pathname : "/account",
            )
      }
    >
      <Icon name="user" />
      <span>{signedIn ? "Личный кабинет" : "Войти"}</span>
    </Link>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function signOut() {
    setPending(true);
    setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Sign out failed");
      router.replace("/");
      router.refresh();
    } catch {
      setError("Не удалось выйти. Попробуй ещё раз.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="sign-out-control">
      <button
        type="button"
        className="secondary-button"
        onClick={signOut}
        disabled={pending}
      >
        {pending ? "Выходим…" : "Выйти из аккаунта"}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
