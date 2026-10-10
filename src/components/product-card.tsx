import Image from "next/image";
import Link from "next/link";
import type { Product } from "@/server/catalog/repository";
import { formatPrice } from "@/domain/pricing";
import { PreviewButton } from "./audio-player";
import { Icon } from "./icons";

export function ProductCard({ product }: { product: Product }) {
  const price = Math.min(
    ...product.offers
      .filter((offer) => offer.kind !== "EXCLUSIVE")
      .map((offer) => offer.price),
  );
  return (
    <article className="product-card">
      <div className="card-art">
        <Link
          href={`/products/${product.id}`}
          aria-label={`Открыть ${product.title}`}
        >
          <Image
            src={`/media/${product.thumbnailId}`}
            alt={`Обложка ${product.title}`}
            width={480}
            height={480}
            unoptimized
          />
        </Link>
        <span className="type-badge">
          {product.type === "BEAT" ? "Бит" : "Драмкит"}
        </span>
        {Number(product.discount) > 0 && (
          <span className="discount-badge">−{Number(product.discount)}%</span>
        )}
        <PreviewButton track={product} />
      </div>
      <div className="card-content">
        <h2>
          <Link href={`/products/${product.id}`}>{product.title}</Link>
        </h2>
        <p className="card-meta">
          {product.type === "BEAT"
            ? `${product.bpm} BPM · ${product.musicalKey}`
            : "ZIP-архив · аудиопревью"}
        </p>
        <div className="card-bottom">
          <span>
            {product.type === "BEAT" && <small>от </small>}
            {formatPrice(price)}
          </span>
          <Link
            href={`/products/${product.id}`}
            className="card-details"
            aria-label={`Подробнее о ${product.title}`}
          >
            <Icon name="arrow" />
          </Link>
        </div>
      </div>
    </article>
  );
}
