import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { getAccountCounts, getAdminOverview } from "@/server/account";
import { SignOutButton } from "@/components/account-nav";
import { Icon } from "@/components/icons";

export const metadata = { title: "Личный кабинет" };
export default async function AccountPage() {
  const user = await requireUser();
  const admin = user.role === "ADMIN";
  const counts = admin
    ? await getAdminOverview(user)
    : await getAccountCounts(user);
  return (
    <div className="account-page">
      <Link href="/" className="back-link">
        ← Назад в каталог
      </Link>
      <div className="account-heading">
        <div>
          <p className="eyebrow">{admin ? "АДМИНИСТРАТОР" : "ТВОЙ АККАУНТ"}</p>
          <h1>{admin ? "Панель администратора" : "Личный кабинет"}</h1>
        </div>
        <SignOutButton />
      </div>
      <section className="profile-panel" aria-label="Данные аккаунта">
        <span className="profile-avatar" aria-hidden="true">
          {Array.from(user.name)[0]?.toUpperCase()}
        </span>
        <div>
          <h2>{user.name}</h2>
          <p>{user.email}</p>
        </div>
        <span className="role-badge">
          {admin ? "Администратор" : "Покупатель"}
        </span>
      </section>
      {"products" in counts ? (
        <section className="account-section" aria-labelledby="admin-title">
          <div className="section-heading">
            <h2 id="admin-title">Каталог магазина</h2>
          </div>
          <div className="account-stats">
            <div>
              <strong>{counts.products}</strong>
              <span>Всего товаров</span>
            </div>
            <div>
              <strong>{counts.published}</strong>
              <span>Опубликовано</span>
            </div>
          </div>
          <Link href="/" className="text-link">
            Открыть каталог <Icon name="arrow" />
          </Link>
        </section>
      ) : (
        <>
          <section
            className="account-section"
            aria-labelledby="purchases-title"
          >
            <div className="section-heading">
              <h2 id="purchases-title">Мои покупки</h2>
              <span>{counts.purchases}</span>
            </div>
            <div className="account-empty">
              <Icon name="music" width={32} height={32} />
              <h3>
                {counts.purchases
                  ? "Твои покупки сохранены"
                  : "Твой звук ещё впереди"}
              </h3>
              <p>
                Здесь будут приобретённые биты, драмкиты, файлы и условия
                лицензий.
              </p>
              <Link href="/" className="primary-button">
                Найти свой звук <Icon name="arrow" />
              </Link>
            </div>
          </section>
          <section className="account-section" aria-labelledby="pending-title">
            <div className="section-heading">
              <h2 id="pending-title">Незавершённые заказы</h2>
              <span>{counts.pending}</span>
            </div>
            <p className="account-description">
              {counts.pending
                ? "Есть заказы, ожидающие оплаты."
                : "Заказов, ожидающих оплаты, пока нет."}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
