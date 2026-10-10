import type { Metadata } from "next";
import Link from "next/link";
import { AudioPlayerProvider } from "@/components/audio-player";
import { AccountNav } from "@/components/account-nav";
import { getCurrentUser } from "@/server/auth/session";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Beatstore — биты и драмкиты", template: "%s · Beatstore" },
  description:
    "Биты для твоего следующего трека и звуки для собственного продакшена.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getCurrentUser();
  return (
    <html lang="ru">
      <body>
        <AudioPlayerProvider>
          <header className="site-header">
            <div className="header-inner">
              <Link href="/" className="brand" aria-label="Beatstore — каталог">
                <span className="brand-mark" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                beatstore<span className="brand-dot">.</span>
              </Link>
              <nav aria-label="Главная навигация">
                <Link href="/">Каталог</Link>
              </nav>
              <span className="demo-tag">Демо-версия</span>
              <AccountNav signedIn={!!user} />
            </div>
          </header>
          <main className="main-container">{children}</main>
          <footer className="site-footer">
            <span>© {new Date().getFullYear()} Beatstore</span>
            <span>Биты. Звуки. Твой следующий трек.</span>
          </footer>
        </AudioPlayerProvider>
      </body>
    </html>
  );
}
