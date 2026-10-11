"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
export function DownloadButton({
  url,
  body,
  label,
  retry = false,
}: {
  url: string;
  body: Record<string, unknown>;
  label: string;
  retry?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const running = useRef(false),
    router = useRouter();
  async function download() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.message);
      if (!retry) {
        if (
          typeof value.url !== "string" ||
          !value.url.startsWith("/api/downloads?token=")
        )
          throw new Error("Не удалось получить ссылку.");
        const a = document.createElement("a");
        a.href = value.url;
        a.referrerPolicy = "no-referrer";
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      router.refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось подготовить скачивание.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="download-control">
      <button
        className="secondary-button"
        disabled={busy}
        onClick={() => void download()}
      >
        {busy ? "Подготавливаем…" : label}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
