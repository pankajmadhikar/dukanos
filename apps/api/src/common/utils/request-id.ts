import { randomUUID } from "node:crypto";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

export function resolveRequestId(
  header: string | string[] | undefined,
): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value && REQUEST_ID.test(value)) {
    return value;
  }
  return randomUUID();
}
