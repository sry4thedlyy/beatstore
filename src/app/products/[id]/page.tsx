import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PreviewButton } from "@/components/audio-player";
import { LicenseOptions } from "@/components/license-options";
import { getProducts } from "@/server/catalog/repository";
import { getCurrentUser } from "@/server/auth/session";
import { getAdminProductView, getEditorProduct } from "@/server/catalog/admin";
import { CatalogError, statusNames } from "@/domain/catalog-editor";

export const dynamic = "force-dynamic";
const getProduct = cache(async (id: string) => {
  const user = await getCurrentUser();
  if (user?.role === "ADMIN") {
    try {
      const item = await getEditorProduct(user, id);
      return {
        product: await getAdminProductView(user, id),
        status: item.status,
      };
    } catch (error) {
      if (error instanceof CatalogError && error.status === 404) return null;
      throw error;
    }
  }
  const product = (await getProducts("", id))[0];
  return product ? { product, status: null } : null;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const product = await getProduct((await params).id);
  return { title: product?.product.title ?? "Товар не найден" };
}

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ license?: string }>;
}) {
  const visible = await getProduct((await params).id);
  if (!visible) notFound();
  const { product, status } = visible;
  return (
    <>
      <Link href="/" className="back-link">
        ← Назад в каталог
      </Link>
      {status && (
        <div className="product-admin-bar">
          <span className={`status-badge status-${status.toLowerCase()}`}>
            {statusNames[status]}
          </span>
          <Link
            className="secondary-button"
            href={`/products/${product.id}/edit`}
          >
            Редактировать товар
          </Link>
        </div>
      )}
      <div className="product-detail">
        <section className="detail-summary">
          <div className="detail-art">
            {product.coverId ? (
              <Image
                src={`${product.mediaBase ?? "/media"}/${product.coverId}`}
                alt={`Обложка ${product.title}`}
                width={1200}
                height={1200}
                unoptimized
                priority
              />
            ) : (
              <div className="cover-placeholder">Обложка ещё не загружена</div>
            )}
          </div>
          <div className="detail-heading">
            <p className="eyebrow">
              {product.type === "BEAT" ? "БИТ" : "ДРАМКИТ"}
            </p>
            <h1>{product.title}</h1>
            <p className="detail-description">{product.description}</p>
            {product.type === "BEAT" && (
              <dl className="beat-info">
                <div>
                  <dt>Темп</dt>
                  <dd>{product.bpm} BPM</dd>
                </div>
                <div>
                  <dt>Тональность</dt>
                  <dd>{product.musicalKey}</dd>
                </div>
                <div>
                  <dt>Авторы</dt>
                  <dd>{product.authors.join(", ")}</dd>
                </div>
                <div>
                  <dt>Длительность</dt>
                  <dd>
                    {product.duration
                      ? `${Math.floor(product.duration / 60)}:${String(product.duration % 60).padStart(2, "0")}`
                      : "—"}
                  </dd>
                </div>
              </dl>
            )}
            {product.previewId && <PreviewButton track={product} large />}
          </div>
        </section>
        <div className="detail-conditions">
          <LicenseOptions
            offers={product.offers}
            discount={product.discount}
            royalty={product.royalty}
            productId={product.id}
            initialKind={(await searchParams).license}
            unavailable={
              !!product.reserved || (!!status && status !== "PUBLISHED")
            }
          />
          {product.type === "BEAT" && (
            <>
              <section className="info-panel">
                <h2>Бесплатный MP3</h2>
                <p>
                  Для зарегистрированных пользователей — полный MP3 для
                  использования без монетизации. Для коммерческого трека нужна
                  платная лицензия. После продажи эксклюзива бесплатное
                  разрешение прекращается.
                </p>
                {(!status || status === "PUBLISHED") && (
                  <Link
                    className="secondary-button"
                    href={`/products/${product.id}/free`}
                  >
                    Скачать бесплатный MP3
                  </Link>
                )}
              </section>
              <section className="info-panel">
                <h2>Проект FL Studio</h2>
                <p>{product.projectRequirements}</p>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
