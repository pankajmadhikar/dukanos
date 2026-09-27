export function shopCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `dukaan_shop=${value}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function clearShopCookie(secure: boolean): string {
  return shopCookie("", secure, 0);
}
