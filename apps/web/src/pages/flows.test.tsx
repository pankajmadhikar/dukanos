import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "../app/router";
import { ApiError } from "../lib/api/client";
import { useOffline } from "../offline/connectivity";
import { asList, asRecord, asText, type Json } from "../lib/json";
import { useSession } from "../stores/session";

const request = vi.fn();
const putBytes = vi.fn();

vi.mock("../lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("../lib/api/client")>("../lib/api/client");
  return { ...actual, request: (...args: unknown[]) => request(...args), putBytes: (...args: unknown[]) => putBytes(...args) };
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

function owner() {
  useSession.getState().setLogin("token", { id: "u1", name: "Asha", phone: "9876543210" });
  useSession.getState().setShop({ id: "shop", name: "Sharma General Store", role: "OWNER", shopContext: "grant" });
}

function cashier() {
  useSession.getState().setLogin("token", { id: "u2", name: "Ravi", phone: "9876543211" });
  useSession.getState().setShop({ id: "shop", name: "Sharma General Store", role: "CASHIER", shopContext: "grant" });
}

function body(data: Json, extra: Record<string, Json> = {}): Record<string, Json> {
  return { data, requestId: "req-1", ...extra };
}

describe("shop flows", () => {
  beforeEach(() => {
    request.mockReset();
    putBytes.mockReset();
    putBytes.mockResolvedValue(undefined);
  });

  it("signs in with OTP and opens a shop", async () => {
    const user = userEvent.setup();
    request.mockImplementation(async (path: string) => {
      if (path.endsWith("/request-otp")) return body({ status: "accepted" });
      if (path.endsWith("/verify-otp")) {
        return body({ token: "session-token", user: { id: "u1", name: "Asha", phone: "9876543210" } });
      }
      if (path === "/api/v1/tenants") return body([{ id: "shop", name: "Sharma General Store", role: "OWNER" }]);
      if (path.endsWith("/select")) {
        return body({ id: "shop", name: "Sharma General Store", role: "OWNER", shopContext: "grant" });
      }
      return body({
        businessDate: "2026-09-27",
        sales: { netSales: "24500.00", transactionCount: 42, quantitySold: "87.000" },
        collections: { cash: "100.00", upi: "50.00", customerCollections: "0.00" },
        outstanding: { customer: "0.00" },
      });
    });
    renderAt("/login");
    await user.type(screen.getByLabelText(/mobile number/i), "9876543210");
    await user.click(screen.getByRole("button", { name: "Send OTP" }));
    await user.type(screen.getByLabelText(/otp/i), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(request.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(["/api/v1/auth/verify-otp"])));
    expect(await screen.findByRole("heading", { name: "Your shops" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open shop" }));
    expect(await screen.findByText(/how is the shop doing today/i)).toBeInTheDocument();
    expect(screen.getByText("₹24,500")).toBeInTheDocument();
  });

  it("sells a product and keeps the cart when stock is short", async () => {
    owner();
    const user = userEvent.setup();
    request.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path.startsWith("/api/v1/catalog/products") && !path.includes("quote")) {
        return body([{ id: "p1", name: "Parle-G", sellingPrice: "10.00", sku: "PG", barcode: "890" }]);
      }
      if (path.startsWith("/api/v1/inventory")) {
        return body([{ product: { id: "p1", name: "Parle-G" }, quantity: "2.000" }]);
      }
      if (path.endsWith("/sales/quote")) {
        return body({
          total: "10.00",
          items: [{ productId: "p1", quantity: "1.000", unitPrice: "10.00", lineTotal: "10.00", priceSource: "LIST" }],
        });
      }
      if (path === "/api/v1/customers") return body([]);
      if (path === "/api/v1/sales" && options?.method === "POST") {
        throw new ApiError("Not enough stock for Parle-G. Available: 2. Requested: 5.", "INSUFFICIENT_STOCK", 409, "STK1", false);
      }
      return body({});
    });
    renderAt("/sell");
    await user.type(screen.getByPlaceholderText("Search products..."), "Parle");
    await user.click(await screen.findByRole("button", { name: /Parle-G/ }));
    expect(await screen.findAllByText("₹10")).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "+" }));
    await user.click(screen.getByRole("button", { name: "Complete sale" }));
    expect(await screen.findByText(/Not enough stock for Parle-G/)).toBeInTheDocument();
    expect(screen.getAllByText("Parle-G").length).toBeGreaterThan(0);
  });

  it("completes a cash sale", async () => {
    owner();
    const user = userEvent.setup();
    request.mockImplementation(async (path: string, options?: { method?: string; body?: Json }) => {
      if (path.startsWith("/api/v1/catalog/products")) {
        return body([{ id: "p1", name: "Parle-G", sellingPrice: "10.00" }]);
      }
      if (path.startsWith("/api/v1/inventory")) return body([]);
      if (path.endsWith("/quote")) {
        return body({
          total: "8.00",
          items: [{ productId: "p1", unitPrice: "8.00", lineTotal: "8.00", priceSource: "CUSTOMER" }],
        });
      }
      if (path.startsWith("/api/v1/customers")) return body([{ id: "c1", name: "Rajesh", phone: "9999999999" }]);
      if (path === "/api/v1/sales" && options?.method === "POST") {
        const sent = asRecord(options.body ?? null);
        expect(asText(asRecord(asList(sent?.items)[0])?.unitPrice)).toBe("");
        return body({
          id: "sale-1",
          saleNumber: "S-00042",
          total: "8.00",
          payments: [{ id: "pay", method: "CASH", amount: "8.00" }],
        });
      }
      return body({});
    });
    renderAt("/sell");
    await user.type(screen.getByPlaceholderText("Search products..."), "Parle");
    await user.click(await screen.findByRole("button", { name: /Parle-G/ }));
    await user.type(screen.getByPlaceholderText("Walk-in customer"), "Raj");
    await user.click(await screen.findByRole("button", { name: /Rajesh/ }));
    expect(await screen.findByText(/Customer price/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Complete sale" }));
    expect(await screen.findByRole("heading", { name: "Sale completed" })).toBeInTheDocument();
    expect(screen.getByText("S-00042")).toBeInTheDocument();
  });

  it("hides profit and supplier money from a cashier", async () => {
    cashier();
    request.mockImplementation(async (path: string) => {
      if (path.includes("/dashboard/today")) {
        return body({
          businessDate: "2026-09-27",
          sales: { netSales: "100.00", transactionCount: 1, quantitySold: "1.000" },
          collections: { cash: "100.00", upi: "0.00", customerCollections: "0.00" },
          outstanding: { customer: "20.00" },
        });
      }
      if (path.includes("/comparison")) return body({ changePercent: { sales: { netSales: "0.00" } } });
      return body([], { pagination: { page: 1, limit: 1, total: 0 } });
    });
    renderAt("/dashboard");
    expect((await screen.findAllByText("₹100")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/gross profit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/payable/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Expenses" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add expense" })).not.toBeInTheDocument();
  });

  it("lists a product and a low-stock row", async () => {
    owner();
    request.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/catalog/products")) {
        return body([{ id: "p1", name: "Tata Salt", sellingPrice: "28.00", sku: "TS", barcode: "111", isActive: true }]);
      }
      if (path.includes("/reports/stock/low")) {
        return body([{ productId: "p1", name: "Tata Salt", quantity: "2.000", minimumStockLevel: "10.000" }], {
          pagination: { page: 1, limit: 20, total: 1 },
        });
      }
      return body([]);
    });
    const user = userEvent.setup();
    const products = renderAt("/products");
    expect(await screen.findByText("Tata Salt")).toBeInTheDocument();
    expect(screen.getByText("₹28")).toBeInTheDocument();
    products.unmount();
    renderAt("/stock?filter=low");
    expect(await screen.findByText(/Min: 10/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Low stock" }));
    expect(screen.getByText("Tata Salt")).toBeInTheDocument();
  });

  it("blocks a customer payment above the outstanding", async () => {
    owner();
    request.mockImplementation(async (path: string) => {
      if (path === "/api/v1/customers/c1") return body({ id: "c1", name: "Rajesh", phone: "999", receivableBalance: "100.00" });
      if (path.endsWith("/summary")) return body({ outstanding: "100.00", totalSales: "100.00", lastSaleDate: null });
      return body([]);
    });
    const user = userEvent.setup();
    renderAt("/customers/c1");
    await screen.findByText("Rajesh");
    await user.type(screen.getByLabelText("Amount"), "150");
    await user.click(screen.getByRole("button", { name: "Receive payment" }));
    expect(await screen.findByText(/more than the outstanding/i)).toBeInTheDocument();
    expect(request.mock.calls.some((call) => String(call[0]).endsWith("/payments"))).toBe(false);
  });

  it("reviews an AI draft, rejects a line, and keeps the draft when confirm fails", async () => {
    owner();
    const user = userEvent.setup();
    let status = "QUEUED";
    request.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === "/api/v1/ai/intake" && options?.method === "POST") return body({ id: "in1", status: "UPLOADED" });
      if (path.endsWith("/upload-url")) {
        return body({ url: "http://127.0.0.1:3000/api/v1/dev/mock-storage/file", method: "PUT", headers: { "content-type": "image/jpeg" } });
      }
      if (path.endsWith("/process")) {
        status = "DRAFT_READY";
        return body({ status: "QUEUED" });
      }
      if (path === "/api/v1/ai/intake/in1") {
        return body({
          id: "in1",
          status,
          canRetry: false,
          items: [
            {
              id: "item-1",
              status: "PENDING",
              name: "Parle-G",
              quantity: "12.000",
              purchasePrice: "10.00",
              sellingPrice: "12.00",
              unit: "Packet",
              confidence: "0.9400",
              matchType: "EXACT_BARCODE_MATCH",
              needsReview: false,
              matchedProduct: { id: "p1", name: "Parle-G" },
              possibleProduct: null,
            },
            {
              id: "item-2",
              status: "PENDING",
              name: "Shampoo 100ml",
              quantity: null,
              purchasePrice: null,
              sellingPrice: null,
              unit: null,
              confidence: "0.2000",
              matchType: "NEW_PRODUCT",
              needsReview: true,
              matchedProduct: null,
              possibleProduct: { id: "p9", name: "Shampoo" },
            },
          ],
        });
      }
      if (path.endsWith("/reject")) {
        return body({ status: "REJECTED" });
      }
      if (path.endsWith("/confirm")) {
        throw new ApiError("Enter a purchase price before adding stock.", "VALIDATION_ERROR", 400, "AI1", false);
      }
      if (path.includes("/units")) return body([{ id: "u1", name: "Packet" }]);
      if (path.includes("/suppliers")) return body([]);
      return body([]);
    });
    renderAt("/ai");
    const file = new File([Uint8Array.from([1, 2, 3])], "shelf.jpg", { type: "image/jpeg" });
    await user.upload(screen.getByLabelText("Upload image"), file);
    await user.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByText(/We found 2 products/)).toBeInTheDocument();
    expect(screen.getByText("High confidence")).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.queryByText("0.9400")).not.toBeInTheDocument();
    expect(screen.getByText(/Matched product/)).toBeInTheDocument();
    expect(screen.getByText(/Possible match/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Reject" })[1]);
    await waitFor(() => expect(request.mock.calls.some((call) => String(call[0]).includes("/reject"))).toBe(true));
    await user.click(screen.getByRole("button", { name: "Confirm stock" }));
    expect(await screen.findByText(/Nothing was added/)).toBeInTheDocument();
    expect(screen.getByText(/We found 2 products/)).toBeInTheDocument();
  });

  it("keeps purchases, closing, and returns online only", async () => {
    owner();
    useOffline.getState().setBrowserOnline(false);
    renderAt("/purchases");
    expect(await screen.findByRole("heading", { name: "Purchases require an internet connection." })).toBeInTheDocument();
    renderAt("/daily-closing");
    expect(await screen.findByRole("heading", { name: "Daily closing requires an internet connection." })).toBeInTheDocument();
    renderAt("/sales/sale-1");
    expect(await screen.findByRole("heading", { name: "Returns require an internet connection." })).toBeInTheDocument();
    renderAt("/expenses");
    expect(await screen.findByRole("heading", { name: "Expenses require an internet connection." })).toBeInTheDocument();
  });
});
