import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty-state page-empty">
      <p className="eyebrow">404</p>
      <h1>Страница не найдена</h1>
      <p>Возможно, товар уже снят с публикации.</p>
      <Link href="/" className="text-link">
        Вернуться в каталог →
      </Link>
    </div>
  );
}
