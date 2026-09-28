const SECRET = /bearer\s+\S+|otp|session|token|password|api[_-]?key/i;

export function reportClientError(message: string): void {
  const text = SECRET.test(message) ? "client error" : message.slice(0, 180);
  const line = {
    timestamp: new Date().toISOString(),
    level: "error",
    service: "dukaanos-web",
    message: text,
  };
  console.error(JSON.stringify(line));
}
