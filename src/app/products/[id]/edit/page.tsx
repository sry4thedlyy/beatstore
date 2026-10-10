import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/server/auth/session";
import { getEditorProduct } from "@/server/catalog/admin";
import { CatalogError } from "@/domain/catalog-editor";
import { ProductEditor } from "@/components/product-editor";
export const metadata = { title: "Редактирование товара" };
export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  const user = await requireAdmin(`/products/${id}/edit`);
  let product;
  try {
    product = await getEditorProduct(user, id);
  } catch (error) {
    if (error instanceof CatalogError && error.status === 404) notFound();
    throw error;
  }
  return (
    <div className="editor-page">
      <Link className="back-link" href={`/products/${product.id}`}>
        ← Назад к карточке
      </Link>
      <h1>Редактирование {product.type === "BEAT" ? "бита" : "драмкита"}</h1>
      <ProductEditor initial={product} />
    </div>
  );
}
