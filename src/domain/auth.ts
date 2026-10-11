export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// Only shop destinations are accepted; preserve the selected license when present.
export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 500 ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    return "/account";
  try {
    const url = new URL(value, "https://beatstore.invalid");
    if (url.origin !== "https://beatstore.invalid") return "/account";
    if (url.pathname === "/" || url.pathname === "/account")
      return url.pathname;
    if (
      /^\/orders\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        url.pathname,
      )
    )
      return url.pathname;
    if (
      /^\/checkout\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        url.pathname,
      )
    ) {
      const license = url.searchParams.get("license");
      return license &&
        ["MP3", "WAV", "STEMS", "EXCLUSIVE", "DRUMKIT"].includes(license)
        ? `${url.pathname}?license=${license}`
        : "/account";
    }
    if (
      url.pathname === "/products/new" ||
      /^\/products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/edit$/i.test(
        url.pathname,
      )
    )
      return url.pathname;
    if (
      !/^\/products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        url.pathname,
      )
    )
      return "/account";
    const license = url.searchParams.get("license");
    return (
      url.pathname +
      (license && ["MP3", "WAV", "STEMS", "EXCLUSIVE"].includes(license)
        ? `?license=${license}`
        : "")
    );
  } catch {
    return "/account";
  }
}

export function authLink(mode: "login" | "register", returnTo: string): string {
  const destination = safeReturnTo(returnTo);
  return `/${mode}${destination === "/account" ? "" : `?next=${encodeURIComponent(destination)}`}`;
}
