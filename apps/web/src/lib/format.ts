const SHOP_TIME_ZONE = "Asia/Kolkata";

export function formatInr(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "₹0";
  }
  const raw = String(value).trim();
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    return raw;
  }
  const [whole, fraction = ""] = unsigned.split(".");
  const digits = whole.replace(/^0+(?=\d)/, "") || "0";
  const grouped = groupIndian(digits);
  const cents = fraction.replace(/0+$/, "").slice(0, 2);
  const body = cents.length > 0 ? `${grouped}.${cents}` : grouped;
  return `${negative ? "−" : ""}₹${body}`;
}

export function formatQty(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "0";
  }
  const raw = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    return raw;
  }
  return raw.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function formatBusinessDate(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    return value;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function formatInstant(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: SHOP_TIME_ZONE,
  }).format(date);
}

export function moneyInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const [whole, fraction = ""] = trimmed.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

export function stockInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(trimmed)) {
    return null;
  }
  const [whole, fraction = ""] = trimmed.split(".");
  return `${whole}.${fraction.padEnd(3, "0")}`;
}

export function toPaise(value: string): bigint | null {
  const money = moneyInput(value) ?? (/^\d+\.\d{2}$/.test(value) ? value : null);
  if (!money) {
    return null;
  }
  const [whole, fraction] = money.split(".");
  return BigInt(whole) * 100n + BigInt(fraction);
}

export function percentLabel(value: string | null | undefined): string | null {
  if (!value || !/^-?\d+(\.\d+)?$/.test(value)) {
    return null;
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const cents = fraction.replace(/0+$/, "");
  const shown = cents.length > 0 ? `${whole}.${cents.slice(0, 1)}` : whole;
  if (shown === "0") {
    return "0%";
  }
  return `${negative ? "↓" : "↑"} ${shown}%`;
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) {
    return digits;
  }
  const tail = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) {
    groups.unshift(rest);
  }
  return `${groups.join(",")},${tail}`;
}
