export type Json = null | string | number | boolean | Json[] | { [key: string]: Json };

export function asRecord(value: Json | undefined | null): Record<string, Json> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return null;
}

export function asList(value: Json | undefined | null): Json[] {
  return Array.isArray(value) ? value : [];
}

export function asText(value: Json | undefined | null): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function asNumber(value: Json | undefined | null): number | null {
  return typeof value === "number" ? value : null;
}
