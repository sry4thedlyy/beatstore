import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { getAccountCounts, getAdminOverview } from "@/server/account";
import { SignOutButton } from "@/components/account-nav";
import { Icon } from "@/components/icons";
import { getAdminCatalog } from "@/server/catalog/admin";
import { statusNames, STORAGE_LIMIT } from "@/domain/catalog-editor";

export const metadata = { title: "Личный кабинет" };
export default async function AccountPage() {
  const user = await requireUser();
  const admin = user.role === "ADMIN";
  const counts = admin
    ? await getAdminOverview(user)
    : await getAccountCounts(user);
  const catalog = admin ? await getAdminCatalog(user) : null;
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
            <Link href="/products/new" className="primary-button">
              Добавить товар
            </Link>
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
          {catalog && (
            <>
              <p className="storage-summary">
                Файлы и сохраняемые версии:{" "}
                {(catalog.usedBytes / 1024 / 1024).toFixed(1)} МБ из{" "}
                {STORAGE_LIMIT / 1024 / 1024} МБ.
              </p>
              <div className="admin-catalog">
                {catalog.products.length ? (
                  catalog.products.map((product) => (
                    <Link
                      key={product.id}
                      href={`/products/${product.id}`}
                      className="admin-product-row"
                    >
                      <div>
                        <strong>{product.title}</strong>
                        <span>
                          {product.type === "BEAT" ? "Бит" : "Драмкит"}
                        </span>
                      </div>
                      <span
                        className={`status-badge status-${product.status.toLowerCase()}`}
                      >
                        {statusNames[product.status]}
                      </span>
                      <Icon name="arrow" />
                    </Link>
                  ))
                ) : (
                  <p className="account-description">
                    В каталоге пока нет товаров. Создай первый черновик.
                  </p>
                )}
              </div>
            </>
          )}
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
