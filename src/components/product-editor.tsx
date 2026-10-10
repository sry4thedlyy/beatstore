"use client";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  extensions,
  statusNames,
  uploadKinds,
  uploadLimits,
  uploadNames,
  type EditorProduct,
  type UploadKind,
} from "@/domain/catalog-editor";
import { timeLabel } from "./audio-player";

async function sendJson<T>(
  url: string,
  method: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message ?? "Не удалось выполнить действие.");
  return result as T;
}
export function NewProductForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const product = await sendJson<EditorProduct>(
        "/api/admin/products",
        "POST",
        { title: form.get("title"), type: form.get("type") },
      );
      router.replace(`/products/${product.id}/edit`);
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Не удалось создать товар.",
      );
      setPending(false);
    }
  }
  return (
    <form
      onSubmit={submit}
      className="editor-panel new-product-form"
      aria-busy={pending}
    >
      <h2>Начни с черновика</h2>
      <p className="editor-description">
        Он будет виден только тебе. Добавь описание и файлы, затем опубликуй
        товар.
      </p>
      <div className="form-field">
        <label htmlFor="product-type">Тип товара</label>
        <select id="product-type" name="type" defaultValue="BEAT">
          <option value="BEAT">Бит</option>
          <option value="DRUMKIT">Драмкит</option>
        </select>
      </div>
      <div className="form-field">
        <label htmlFor="new-title">Название</label>
        <input
          id="new-title"
          name="title"
          required
          maxLength={160}
          placeholder="Название бита или драмкита"
        />
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary-button" disabled={pending}>
        {pending ? "Создаём…" : "Создать черновик"}
      </button>
    </form>
  );
}
const asRubles = (kopecks: number | null) =>
  kopecks === null
    ? ""
    : `${Math.floor(kopecks / 100)}.${String(kopecks % 100).padStart(2, "0")}`;
const sizeLabel = (size: number) => `${(size / 1024 / 1024).toFixed(1)} МБ`;
export function ProductEditor({ initial }: { initial: EditorProduct }) {
  const router = useRouter();
  const [product, setProduct] = useState(initial),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const [progress, setProgress] = useState<{
      kind: UploadKind;
      percent: number;
    } | null>(null),
    [confirmation, setConfirmation] = useState("");
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  useEffect(() => () => xhrRef.current?.abort(), []);
  const endpoint = `/api/admin/products/${product.id}`;
  function begin() {
    setPending(true);
    setError("");
    setSuccess("");
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || product.locked) return;
    const values = new FormData(event.currentTarget);
    const action =
      (event.nativeEvent as SubmitEvent).submitter instanceof HTMLButtonElement
        ? ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement)
            .value
        : "save";
    begin();
    try {
      const next = await sendJson<EditorProduct>(endpoint, "PATCH", {
        revision: product.revision,
        action: action || "save",
        title: values.get("title"),
        description: values.get("description"),
        discount: values.get("discount"),
        price: values.get("price"),
        authors: String(values.get("authors") ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        bpm: values.get("bpm") ?? "",
        musicalKey: values.get("musicalKey") ?? "",
        royalty: values.get("royalty") ?? "0",
        projectRequirements: values.get("projectRequirements") ?? "",
        usageRules: values.get("usageRules") ?? "",
      });
      setProduct(next);
      setSuccess(
        action === "publish"
          ? "Товар опубликован."
          : action === "unpublish"
            ? "Товар снят с публикации."
            : "Изменения сохранены.",
      );
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Не удалось сохранить товар.",
      );
    } finally {
      setPending(false);
    }
  }
  async function upload(kind: UploadKind, file: File) {
    if (pending || product.locked) return;
    if (file.size < 1 || file.size > uploadLimits[kind]) {
      setError(
        `Файл пуст или превышает ${uploadLimits[kind] / 1024 / 1024} МБ.`,
      );
      return;
    }
    begin();
    setProgress({ kind, percent: 0 });
    try {
      const next = await new Promise<EditorProduct>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        xhr.open("PUT", `${endpoint}/files/${kind}`);
        xhr.responseType = "json";
        xhr.timeout = 10 * 60 * 1000;
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
        xhr.setRequestHeader("X-File-Size", String(file.size));
        xhr.setRequestHeader("X-Product-Revision", String(product.revision));
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable)
            setProgress({
              kind,
              percent: Math.round((e.loaded / e.total) * 100),
            });
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
          else
            reject(
              new Error(xhr.response?.message ?? "Не удалось загрузить файл."),
            );
        };
        xhr.onerror = () =>
          reject(
            new Error("Не удалось связаться с сервером. Повтори загрузку."),
          );
        xhr.ontimeout = () =>
          reject(
            new Error(
              "Загрузка заняла слишком много времени. Попробуй ещё раз.",
            ),
          );
        xhr.onabort = () => reject(new Error("Загрузка отменена."));
        xhr.send(file);
      });
      setProduct(next);
      setSuccess(`${uploadNames[kind]}: файл загружен.`);
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Не удалось загрузить файл.",
      );
    } finally {
      setPending(false);
      setProgress(null);
      xhrRef.current = null;
    }
  }
  async function remove() {
    if (
      pending ||
      product.locked ||
      product.hasPurchases ||
      confirmation !== product.title
    )
      return;
    begin();
    try {
      await sendJson(endpoint, "DELETE", {
        revision: product.revision,
        confirmation,
      });
      router.replace("/account");
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Не удалось удалить товар.",
      );
      setPending(false);
    }
  }
  return (
    <div className="editor-content">
      <div className="editor-status">
        <span className={`status-badge status-${product.status.toLowerCase()}`}>
          {statusNames[product.status]}
        </span>
        <Link href={`/products/${product.id}`} className="text-link">
          Открыть карточку →
        </Link>
      </div>
      {product.locked && (
        <p className="editor-notice" role="status">
          Изменения недоступны: есть незавершённая оплата, резерв или проданный
          эксклюзив.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="form-success" role="status">
          {success}
        </p>
      )}
      <form onSubmit={save} className="editor-form" aria-busy={pending}>
        <fieldset disabled={pending || product.locked} className="editor-panel">
          <legend>Информация о товаре</legend>
          <div className="form-field">
            <label htmlFor="product-title">Название</label>
            <input
              id="product-title"
              name="title"
              defaultValue={product.title}
              required
              maxLength={160}
            />
          </div>
          <div className="form-field">
            <label htmlFor="product-description">Описание</label>
            <textarea
              id="product-description"
              name="description"
              defaultValue={product.description}
              rows={4}
              maxLength={10000}
            />
          </div>
          {product.type === "BEAT" && (
            <>
              <div className="form-field">
                <label htmlFor="product-authors">Авторы и соавторы</label>
                <textarea
                  id="product-authors"
                  name="authors"
                  defaultValue={product.authors.join("\n")}
                  rows={3}
                  maxLength={1620}
                />
                <p className="field-help">
                  Каждый автор — на отдельной строке, до 20 имён.
                </p>
              </div>
              <div className="editor-grid">
                <div className="form-field">
                  <label htmlFor="product-bpm">BPM</label>
                  <input
                    id="product-bpm"
                    name="bpm"
                    inputMode="numeric"
                    defaultValue={product.bpm ?? ""}
                    maxLength={3}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="product-key">Тональность</label>
                  <input
                    id="product-key"
                    name="musicalKey"
                    defaultValue={product.musicalKey ?? ""}
                    maxLength={80}
                    placeholder="Например, C minor"
                  />
                </div>
              </div>
              <div className="form-field">
                <label htmlFor="project-requirements">
                  Требования к проекту
                </label>
                <textarea
                  id="project-requirements"
                  name="projectRequirements"
                  defaultValue={product.projectRequirements ?? ""}
                  maxLength={5000}
                  rows={3}
                />
                <p className="field-help">
                  Версия FL Studio, сторонние плагины и библиотеки.
                </p>
              </div>
            </>
          )}
        </fieldset>
        <fieldset disabled={pending || product.locked} className="editor-panel">
          <legend>Цена и условия</legend>
          {product.type === "BEAT" && (
            <p className="editor-description">
              MP3 — 1 000 ₽ · WAV — 2 000 ₽ · STEMS — 3 000 ₽. Скидка
              применяется к этим трём вариантам.
            </p>
          )}
          <div className="editor-grid">
            <div className="form-field">
              <label htmlFor="product-price">
                {product.type === "BEAT"
                  ? "Цена эксклюзива, ₽"
                  : "Цена драмкита, ₽"}
              </label>
              <input
                id="product-price"
                name="price"
                inputMode="decimal"
                defaultValue={asRubles(product.price)}
                maxLength={12}
              />
            </div>
            <div className="form-field">
              <label htmlFor="product-discount">Скидка, %</label>
              <input
                id="product-discount"
                name="discount"
                inputMode="decimal"
                defaultValue={product.discount}
                required
                maxLength={6}
              />
              <p className="field-help">От 0 до 99,99%.</p>
            </div>
          </div>
          {product.type === "BEAT" ? (
            <div className="form-field">
              <label htmlFor="product-royalty">Роялти, %</label>
              <input
                id="product-royalty"
                name="royalty"
                inputMode="decimal"
                defaultValue={product.royalty ?? "0"}
                required
                maxLength={6}
              />
              <p className="field-help">
                Доход от стриминга после комиссий. Выплаты по календарным
                кварталам.
              </p>
            </div>
          ) : (
            <div className="form-field">
              <label htmlFor="product-rules">
                Правила использования звуков
              </label>
              <textarea
                id="product-rules"
                name="usageRules"
                defaultValue={product.usageRules}
                maxLength={10000}
                rows={5}
              />
              <p className="field-help">
                Эти же правила должны быть в текстовом файле внутри ZIP.
                Перепродажа и распространение архива запрещены.
              </p>
            </div>
          )}
        </fieldset>
        <div className="editor-actions">
          <button
            className="secondary-button"
            type="submit"
            value="save"
            disabled={pending || product.locked}
          >
            Сохранить изменения
          </button>
          {product.status === "PUBLISHED" ? (
            <button
              className="secondary-button"
              type="submit"
              value="unpublish"
              disabled={pending || product.locked}
            >
              Снять с публикации
            </button>
          ) : (
            <button
              className="primary-button"
              type="submit"
              value="publish"
              disabled={pending || product.locked}
            >
              Опубликовать
            </button>
          )}
        </div>
      </form>
      <section className="editor-panel" aria-labelledby="files-title">
        <h2 id="files-title">Файлы товара</h2>
        <p className="editor-description">
          Выбор файла запускает загрузку. При замене предыдущая версия
          сохраняется для покупок.
        </p>
        {product.duration && (
          <p className="field-help">
            Длительность превью: {timeLabel(product.duration)}
          </p>
        )}
        <div className="upload-list">
          {uploadKinds(product.type).map((kind) => (
            <div className="upload-row" key={kind}>
              <div className="upload-description">
                <label htmlFor={`upload-${kind}`}>{uploadNames[kind]}</label>
                <p>
                  {product.files[kind]
                    ? `${product.files[kind]!.name} · ${sizeLabel(product.files[kind]!.size)}`
                    : "Файл ещё не загружен"}
                </p>
                <span className="field-help">
                  {kind === "COVER"
                    ? "JPEG, PNG, WebP"
                    : kind === "MP3" || kind === "PREVIEW"
                      ? "MP3"
                      : kind === "WAV"
                        ? "WAV"
                        : "ZIP"}{" "}
                  · до {uploadLimits[kind] / 1024 / 1024} МБ
                </span>
              </div>
              {kind === "COVER" && product.files.COVER && (
                <Image
                  className="upload-cover"
                  src={`/api/admin/media/${product.files.COVER.id}`}
                  width={64}
                  height={64}
                  alt="Загруженная обложка"
                  unoptimized
                />
              )}
              <input
                id={`upload-${kind}`}
                type="file"
                accept={extensions[kind]}
                disabled={pending || product.locked}
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (file) void upload(kind, file);
                }}
              />
            </div>
          ))}
        </div>
        {progress && (
          <div className="upload-progress" role="status">
            <p>
              {uploadNames[progress.kind]}:{" "}
              {progress.percent === 100
                ? "проверка и сохранение…"
                : `${progress.percent}%`}
            </p>
            <progress
              max={100}
              value={progress.percent}
              aria-label="Прогресс загрузки"
            />
            <button
              type="button"
              className="text-button"
              onClick={() => xhrRef.current?.abort()}
            >
              Отменить загрузку
            </button>
          </div>
        )}
      </section>
      {product.missing.length > 0 && (
        <section className="editor-panel editor-readiness">
          <h2>Перед публикацией</h2>
          <p>Ещё нужно добавить:</p>
          <ul>
            {product.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="field-help">
            Список обновляется после сохранения полей и загрузки файлов.
          </p>
        </section>
      )}
      <section className="editor-panel editor-danger">
        <h2>Удаление товара</h2>
        {product.hasPurchases ? (
          <p>
            У товара есть покупки. Для прекращения новых продаж сними его с
            публикации.
          </p>
        ) : (
          <>
            <p>
              Карточка будет удалена окончательно. Для подтверждения введи её
              название: <strong>{product.title}</strong>.
            </p>
            <label className="sr-only" htmlFor="delete-confirmation">
              Название для подтверждения удаления
            </label>
            <input
              id="delete-confirmation"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
              disabled={pending || product.locked}
            />
            <button
              type="button"
              className="danger-button"
              disabled={
                pending || product.locked || confirmation !== product.title
              }
              onClick={remove}
            >
              Удалить товар
            </button>
          </>
        )}
      </section>
    </div>
  );
}
