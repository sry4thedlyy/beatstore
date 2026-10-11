class RequestError extends Error {}

// Transport failures must not expose browser exceptions in the shop interface.
export async function readJson<T>(
  response: Response,
  fallback: string,
): Promise<T> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new RequestError(fallback);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(fallback);
  if (!response.ok) {
    const message = "message" in value ? value.message : undefined;
    throw new RequestError(
      typeof message === "string" && message.trim() ? message : fallback,
    );
  }
  return value as T;
}

export function requestFailure(error: unknown, fallback: string): string {
  return error instanceof RequestError ? error.message : fallback;
}
