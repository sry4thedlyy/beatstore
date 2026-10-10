"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="empty-state page-empty">
      <h1>Не удалось загрузить страницу</h1>
      <p>Попробуй обновить её через несколько секунд.</p>
      <button type="button" className="primary-button" onClick={reset}>
        Попробовать снова
      </button>
    </div>
  );
}
