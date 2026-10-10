import Link from "next/link";
import { requireAdmin } from "@/server/auth/session";
import { NewProductForm } from "@/components/product-editor";
export const metadata = { title: "Новый товар" };
export default async function NewProductPage() {
  await requireAdmin("/products/new");
  return (
    <div className="editor-page">
      <Link className="back-link" href="/account">
        ← Назад в кабинет
      </Link>
      <h1>Новый товар</h1>
      <NewProductForm />
    </div>
  );
}
