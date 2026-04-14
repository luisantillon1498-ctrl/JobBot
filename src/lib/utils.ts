import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Storage object keys must be S3-safe; original names with accents or symbols otherwise cause 400 Invalid key. */
export function sanitizeStorageFileName(originalName: string): string {
  const lastDot = originalName.lastIndexOf(".");
  const rawExt = lastDot > 0 ? originalName.slice(lastDot) : "";
  const ext = rawExt.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 12) || "";
  const base = (lastDot > 0 ? originalName.slice(0, lastDot) : originalName)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "file";
  return ext ? `${base}${ext}` : base;
}
