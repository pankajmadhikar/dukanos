export function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeSku(value: string): string {
  return value.trim().replace(/\s+/g, "").toUpperCase();
}

export function normalizeBarcode(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

/** Trim and collapse spaces. Unicode letters stay as the shopkeeper typed them. */
export function normalizeSearch(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
