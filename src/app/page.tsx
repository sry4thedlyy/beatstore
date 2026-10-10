import Link from "next/link";
import Form from "next/form";
import { ProductCard } from "@/components/product-card";
import { Icon } from "@/components/icons";
import { getProducts } from "@/server/catalog/repository";

export const dynamic = "force-dynamic";

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const params = await searchParams;
  const search = (typeof params.q === "string" ? params.q : "")
    .trim()
    .slice(0, 120);
  const products = await getProducts(search);
  return (
    <>
      <section className="catalog-intro">
        <p className="eyebrow">
          <span /> БИТЫ И ЗВУКИ ОТ АВТОРА
        </p>
        <h1>
          Твой звук.
          <br />
          <span>Твоя следующая история.</span>
        </h1>
        <p className="intro-description">
          Найди бит для нового трека или собери свой звук
          <br className="desktop-break" /> с драмкитами для продакшена.
        </p>
        <div className="intro-decoration" aria-hidden="true">
          {Array.from({ length: 17 }, (_, index) => (
            <i
              key={index}
              style={{ height: `${24 + Math.sin(index * 1.1) ** 2 * 88}px` }}
            />
          ))}
        </div>
      </section>
      <section aria-labelledby="catalog-title">
        <div className="catalog-toolbar">
          <div className="catalog-heading">
            <h2 id="catalog-title">Каталог</h2>
            <span>{products.length}</span>
          </div>
          <Form action="/" className="search-form" role="search">
            <Icon name="search" />
            <label className="sr-only" htmlFor="catalog-search">
              Поиск по названию
            </label>
            <input
              key={search}
              id="catalog-search"
              name="q"
              type="search"
              placeholder="Поиск по названию"
              defaultValue={search}
              maxLength={120}
            />
            <button type="submit">Найти</button>
          </Form>
        </div>
        {search && (
          <p className="search-result">
            Поиск: «{search}» <Link href="/">Сбросить</Link>
          </p>
        )}
        {products.length ? (
          <div className="product-grid">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Icon name="search" width={36} height={36} />
            <h3>
              {search
                ? "Ничего не найдено"
                : "Скоро здесь появятся новые звуки"}
            </h3>
            <p>
              {search
                ? "Попробуй другое название или вернись ко всему каталогу."
                : "Загляни немного позже."}
            </p>
            {search && (
              <Link href="/" className="text-link">
                Открыть весь каталог <Icon name="arrow" />
              </Link>
            )}
          </div>
        )}
      </section>
      <div className="catalog-note">
        <span className="note-dot" />
        <p>
          Сначала послушай. Все биты и драмкиты доступны для знакомства в
          плеере.
        </p>
      </div>
    </>
  );
}
