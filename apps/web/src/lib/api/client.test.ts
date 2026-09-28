import { describe, expect, it } from "vitest";
import { ApiError } from "./client";

describe("API errors", () => {
  it("shows the shop message and request id", () => {
    const error = new ApiError("Payment exceeds outstanding", "PAYMENT_EXCEEDS_OUTSTANDING", 409, "ABC123", false);
    expect(error.shopText()).toBe("Payment exceeds outstanding\nRequest ID: ABC123");
  });

  it("uses an offline message instead of a stack", () => {
    const error = new ApiError("You're offline.", "OFFLINE", 0, null, true);
    expect(error.shopText()).toContain("You're offline.");
    expect(error.shopText()).toContain("Please check your internet connection.");
    expect(error.shopText()).not.toContain("Error:");
  });
});
