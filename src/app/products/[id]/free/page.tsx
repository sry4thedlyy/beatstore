import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { getDatabase } from "@/server/db/connection";
import { getFreeDownload } from "@/server/delivery/service";
import { DeliveryError } from "@/domain/delivery";
import { FreeDownloadForm } from "@/components/free-download-form";
export const metadata = { title: "Бесплатный MP3" };
export default async function FreePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params,
    user = await requireUser(`/products/${id}/free`);
  let quote;
  try {
    quote = await getFreeDownload(user, id, await getDatabase());
  } catch (e) {
    if (e instanceof DeliveryError && e.status === 404) notFound();
    throw e;
  }
  return (
    <div className="checkout-page free-download-page">
      <Link href={`/products/${id}`} className="back-link">
        ← Назад к биту
      </Link>
      <p className="eyebrow">БЕЗ МОНЕТИЗАЦИИ</p>
      <h1>{quote.title}</h1>
      <FreeDownloadForm quote={quote} />
    </div>
  );
}
