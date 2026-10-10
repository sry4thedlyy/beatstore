"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  authLink,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  safeReturnTo,
} from "@/domain/auth";
import { authClient } from "./auth-client";
import { Icon } from "./icons";

type Mode = "login" | "register" | "forgot" | "reset";
const headings: Record<Mode, string> = {
  login: "С возвращением",
  register: "Создай аккаунт",
  forgot: "Восстановить пароль",
  reset: "Новый пароль",
};
const descriptions: Record<Mode, string> = {
  login: "Войди, чтобы вернуться к своим битам и звукам.",
  register: "Твои покупки, файлы и лицензии будут в одном месте.",
  forgot: "Укажи email своего аккаунта. Мы отправим ссылку для смены пароля.",
  reset: "Придумай новый пароль для своего аккаунта.",
};
const labels: Record<Mode, string> = {
  login: "Войти",
  register: "Зарегистрироваться",
  forgot: "Отправить ссылку",
  reset: "Сохранить пароль",
};

function errorMessage(error: { code?: string; status?: number }): string {
  if (error.status === 429)
    return "Слишком много попыток. Подожди несколько минут и попробуй снова.";
  const messages: Record<string, string> = {
    INVALID_EMAIL_OR_PASSWORD: "Неверный email или пароль.",
    USER_ALREADY_EXISTS: "Аккаунт с этим email уже существует. Попробуй войти.",
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
      "Аккаунт с этим email уже существует. Попробуй войти.",
    INVALID_EMAIL: "Проверь email — кажется, в нём ошибка.",
    PASSWORD_TOO_SHORT: `Пароль должен содержать не менее ${PASSWORD_MIN_LENGTH} символов.`,
    PASSWORD_TOO_LONG: `Пароль должен содержать не более ${PASSWORD_MAX_LENGTH} символов.`,
    INVALID_TOKEN: "Ссылка недействительна или устарела. Запроси новую.",
    TOKEN_EXPIRED: "Ссылка устарела. Запроси новую.",
    INVALID_NAME: "Укажи имя артиста или псевдоним — от 1 до 80 символов.",
  };
  return (
    messages[error.code ?? ""] ??
    "Не удалось выполнить действие. Попробуй ещё раз."
  );
}

export function AuthForm({
  mode,
  returnTo = "/account",
  token,
  resetComplete = false,
}: {
  mode: Mode;
  returnTo?: string;
  token?: string;
  resetComplete?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const destination = safeReturnTo(returnTo);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(form.get("password") ?? "");
    setError("");
    if (
      (mode === "register" || mode === "reset") &&
      password !== form.get("confirmation")
    ) {
      setError("Пароли не совпадают.");
      return;
    }
    setPending(true);
    try {
      const result =
        mode === "register"
          ? await authClient.signUp.email({
              email,
              password,
              name: String(form.get("name") ?? "").trim(),
            })
          : mode === "login"
            ? await authClient.signIn.email({
                email,
                password,
                rememberMe: true,
              })
            : mode === "forgot"
              ? await authClient.requestPasswordReset({
                  email,
                  redirectTo: "/reset-password",
                })
              : await authClient.resetPassword({
                  newPassword: password,
                  token: token ?? "",
                });
      if (result.error) {
        setError(errorMessage(result.error));
        return;
      }
      if (mode === "forgot") setSent(true);
      else if (mode === "reset") {
        router.replace("/login?reset=success");
        router.refresh();
      } else {
        router.replace(destination);
        router.refresh();
      }
    } catch {
      setError(
        "Не удалось связаться с сервером. Проверь соединение и попробуй снова.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="auth-panel" aria-labelledby="auth-title">
      <div className="auth-mark">
        <Icon name="lock" />
      </div>
      <h1 id="auth-title">{headings[mode]}</h1>
      <p className="auth-description">{descriptions[mode]}</p>
      {resetComplete && (
        <p className="form-success" role="status">
          Пароль обновлён. Войди с новым паролем.
        </p>
      )}
      {sent ? (
        <div className="form-success" role="status">
          <strong>Проверь почту</strong>
          <p>
            Если аккаунт с этим email существует, ссылка для восстановления
            отправлена. Она действует 30 минут.
          </p>
        </div>
      ) : mode === "reset" && !token ? (
        <div className="form-error" role="alert">
          Ссылка недействительна или устарела.{" "}
          <Link href="/forgot-password">Запросить новую</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="auth-form" aria-busy={pending}>
          {mode === "register" && (
            <div className="form-field">
              <label htmlFor="artist-name">Имя артиста или псевдоним</label>
              <input
                id="artist-name"
                name="name"
                autoComplete="nickname"
                required
                maxLength={80}
                placeholder="Как тебя зовут в музыке"
              />
            </div>
          )}
          {mode !== "reset" && (
            <div className="form-field">
              <label htmlFor="auth-email">Email</label>
              <input
                id="auth-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                placeholder="you@example.ru"
              />
            </div>
          )}
          {mode !== "forgot" && (
            <div className="form-field">
              <label htmlFor="auth-password">
                {mode === "reset" ? "Новый пароль" : "Пароль"}
              </label>
              <div className="password-field">
                <input
                  id="auth-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  required
                  minLength={mode === "login" ? undefined : PASSWORD_MIN_LENGTH}
                  maxLength={PASSWORD_MAX_LENGTH}
                  aria-describedby={
                    mode === "login" ? undefined : "password-help"
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={
                    showPassword ? "Скрыть пароль" : "Показать пароль"
                  }
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  <Icon name={showPassword ? "eye-off" : "eye"} />
                </button>
              </div>
              {mode !== "login" && (
                <p className="field-help" id="password-help">
                  От {PASSWORD_MIN_LENGTH} до {PASSWORD_MAX_LENGTH} символов.
                  Можно использовать длинную фразу.
                </p>
              )}
            </div>
          )}
          {(mode === "register" || mode === "reset") && (
            <div className="form-field">
              <label htmlFor="password-confirmation">Повтори пароль</label>
              <input
                id="password-confirmation"
                name="confirmation"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                required
                maxLength={PASSWORD_MAX_LENGTH}
              />
            </div>
          )}
          {mode === "login" && (
            <Link className="auth-forgot" href="/forgot-password">
              Не помню пароль
            </Link>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
              {mode === "reset" && (
                <>
                  <br />
                  <Link href="/forgot-password">Запросить новую ссылку</Link>
                </>
              )}
            </p>
          )}
          <button
            className="primary-button auth-submit"
            type="submit"
            disabled={pending}
          >
            {pending ? "Подожди…" : labels[mode]}
          </button>
        </form>
      )}
      <p className="auth-switch">
        {mode === "login" ? (
          <>
            Нет аккаунта?{" "}
            <Link href={authLink("register", destination)}>
              Зарегистрироваться
            </Link>
          </>
        ) : mode === "register" ? (
          <>
            Уже есть аккаунт?{" "}
            <Link href={authLink("login", destination)}>Войти</Link>
          </>
        ) : (
          <Link href={authLink("login", destination)}>Вернуться ко входу</Link>
        )}
      </p>
    </section>
  );
}
