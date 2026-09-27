const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * India-first canonical form: +91 and 10 digits.
 * 9876543210 and +91 98765 43210 become the same user.
 * The column is still a general phone string, so a later country code can be added here.
 */
export function normalizeIndianPhone(input: string): string {
  const compact = input.trim().replace(/[\s()-]/g, "");
  let national = compact;
  if (national.startsWith("+91")) {
    national = national.slice(3);
  } else if (national.startsWith("91") && national.length === 12) {
    national = national.slice(2);
  } else if (national.startsWith("0") && national.length === 11) {
    national = national.slice(1);
  }
  if (!INDIAN_MOBILE.test(national)) {
    throw new Error("invalid phone");
  }
  return `+91${national}`;
}
