import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PreviewButton } from "@/components/audio-player";
import { LicenseOptions } from "@/components/license-options";
import { getProducts } from "@/server/catalog/repository";

export const dynamic = "force-dynamic";
const getProduct = cache(async (id: string) => (await getProducts("", id))[0]);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const product = await getProduct((await params).id);
  return { title: product?.title ?? "Товар не найден" };
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const product = await getProduct((await params).id);
  if (!product) notFound();
  return (
    <>
      <Link href="/" className="back-link">
        ← Назад в каталог
      </Link>
      <div className="product-detail">
        <section className="detail-summary">
          <div className="detail-art">
            <Image
              src={`/media/${product.coverId}`}
              alt={`Обложка ${product.title}`}
              width={1200}
              height={1200}
              unoptimized
              priority
            />
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
              </dl>
            )}
            <PreviewButton track={product} large />
          </div>
        </section>
        <div className="detail-conditions">
          <LicenseOptions
            offers={product.offers}
            discount={product.discount}
            royalty={product.royalty}
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
