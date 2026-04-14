/**
 * `functions.invoke` sets `error` to FunctionsHttpError on non-2xx; `instanceof` often fails
 * across bundles. The underlying `Response` is on `invokeResponse.response` or `error.context`.
 */
export async function readInvokeHttpErrorBody(
  error: unknown,
  invokeResponse?: Response | null,
): Promise<string | null> {
  const res =
    invokeResponse ??
    (error &&
    typeof error === "object" &&
    error !== null &&
    "context" in error &&
    typeof (error as { context: unknown }).context === "object" &&
    (error as { context: { json?: unknown } }).context !== null &&
    typeof (error as { context: { json?: unknown } }).context.json === "function"
      ? ((error as { context: Response }).context as Response)
      : null);

  if (!res) return null;

  try {
    const body: unknown = await res.clone().json();
    if (body && typeof body === "object" && "error" in body) {
      const msg = (body as { error: unknown }).error;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    }
  } catch {
    try {
      const text = await res.text();
      if (text?.trim()) return text.trim().slice(0, 800);
    } catch {
      /* ignore */
    }
  }
  return null;
}
