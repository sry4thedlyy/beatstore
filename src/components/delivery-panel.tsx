import type { DeliveryView } from "@/domain/delivery";
import { DownloadButton } from "./download-button";
export function DeliveryPanel({
  orderId,
  delivery,
}: {
  orderId: string;
  delivery: DeliveryView;
}) {
  const url = `/api/orders/${orderId}/delivery`;
  return (
    <div className="delivery-panel">
      <h3>Файлы покупки</h3>
      {delivery.allowed && delivery.file ? (
        <>
          <p className="checkout-muted">
            {delivery.file.name} ·{" "}
            {(delivery.file.size / 1024 / 1024).toLocaleString("ru-RU", {
              maximumFractionDigits: 1,
            })}{" "}
            МБ
          </p>
          <DownloadButton
            url={url}
            body={{ action: "file" }}
            label="Скачать приобретённый файл"
          />
        </>
      ) : (
        <p className="checkout-muted">
          Скачивание файлов для этого заказа недоступно.
        </p>
      )}
      {delivery.document && (
        <>
          <h3>Документ лицензии</h3>
          {delivery.document.status === "READY" ? (
            <DownloadButton
              url={url}
              body={{ action: "document" }}
              label="Скачать лицензию PDF"
            />
          ) : (
            <>
              <p className="checkout-muted">
                {delivery.document.status === "FAILED"
                  ? "Не удалось подготовить PDF. Оплата сохранена, файл покупки доступен."
                  : "Документ подготавливается. Его можно получить позже на этой странице."}
              </p>
              <DownloadButton
                url={url}
                body={{ action: "retry-document" }}
                label="Повторить подготовку PDF"
                retry
              />
            </>
          )}
        </>
      )}
      <p className="checkout-muted">
        Скачиваются демонстрационные материалы. Ссылка действует 5 минут и
        требует входа в этот аккаунт. Повторное скачивание доступно с этой
        страницы.
      </p>
    </div>
  );
}
