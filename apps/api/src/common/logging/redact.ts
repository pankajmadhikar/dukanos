const URL_SECRET = /postgres(?:ql)?:\/\/[^\s'")]+/gi;
const SECRET_ASSIGN =
  /\b(password|passwd|token|otp|pin|secret|authorization|api[_-]?key)\b\s*[:=]\s*([^\s,;]+)/gi;

export function redact(value: string): string {
  return value
    .replace(URL_SECRET, "postgresql://***")
    .replace(SECRET_ASSIGN, "$1=***");
}
