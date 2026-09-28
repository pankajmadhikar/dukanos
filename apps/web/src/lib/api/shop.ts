import type { Json } from "../json";
import { putBytes, request } from "./client";

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const shopApi = {
  requestOtp: (phone: string) => request("/api/v1/auth/request-otp", { method: "POST", body: { phone }, auth: false }),
  verifyOtp: (phone: string, code: string) =>
    request("/api/v1/auth/verify-otp", { method: "POST", body: { phone, code }, auth: false }),
  logout: () => request("/api/v1/auth/logout", { method: "POST", body: {} }),
  me: () => request("/api/v1/auth/me"),
  shops: () => request("/api/v1/tenants"),
  selectShop: (tenantId: string) => request(`/api/v1/tenants/${tenantId}/select`, { method: "POST", body: {} }),
  createShop: (body: Json) => request("/api/v1/tenants", { method: "POST", body }),
  currentShop: () => request("/api/v1/tenants/current"),
  dashboardToday: () => request("/api/v1/dashboard/today"),
  dashboardComparison: () => request("/api/v1/dashboard/comparison?period=today"),
  products: (search: string, page: number) =>
    request(`/api/v1/catalog/products${query({ search, page, limit: 20 })}`),
  product: (id: string) => request(`/api/v1/catalog/products/${id}`),
  createProduct: (body: Json) => request("/api/v1/catalog/products", { method: "POST", body }),
  updateProduct: (id: string, body: Json) => request(`/api/v1/catalog/products/${id}`, { method: "PATCH", body }),
  deactivateProduct: (id: string) => request(`/api/v1/catalog/products/${id}/deactivate`, { method: "POST", body: {} }),
  reactivateProduct: (id: string) => request(`/api/v1/catalog/products/${id}/reactivate`, { method: "POST", body: {} }),
  priceHistory: (id: string) => request(`/api/v1/catalog/products/${id}/price-history`),
  barcode: (code: string) => request(`/api/v1/catalog/products/barcode/${encodeURIComponent(code)}`),
  units: () => request("/api/v1/catalog/units"),
  createUnit: (body: Json) => request("/api/v1/catalog/units", { method: "POST", body }),
  categories: () => request("/api/v1/catalog/categories"),
  createCategory: (body: Json) => request("/api/v1/catalog/categories", { method: "POST", body }),
  brands: () => request("/api/v1/catalog/brands"),
  createBrand: (body: Json) => request("/api/v1/catalog/brands", { method: "POST", body }),
  inventory: (params: { search?: string; page?: number; lowStock?: boolean }) =>
    request(
      `/api/v1/inventory${query({
        search: params.search,
        page: params.page ?? 1,
        limit: 20,
        lowStock: params.lowStock ? "true" : undefined,
      })}`,
    ),
  openingStock: (body: Json, idempotencyKey: string) =>
    request("/api/v1/inventory/opening", { method: "POST", body, idempotencyKey }),
  adjustStock: (body: Json, idempotencyKey: string) =>
    request("/api/v1/inventory/adjustments", { method: "POST", body, idempotencyKey }),
  quoteSale: (body: Json) => request("/api/v1/sales/quote", { method: "POST", body }),
  createSale: (body: Json, idempotencyKey: string) =>
    request("/api/v1/sales", { method: "POST", body, idempotencyKey }),
  sales: (page: number, customerId?: string) =>
    request(`/api/v1/sales${query({ page, limit: 20, customerId })}`),
  sale: (id: string) => request(`/api/v1/sales/${id}`),
  createSaleReturn: (body: Json, idempotencyKey: string) =>
    request("/api/v1/sales/returns", { method: "POST", body, idempotencyKey }),
  customers: (search: string, page: number) => request(`/api/v1/customers${query({ search, page, limit: 20 })}`),
  customer: (id: string) => request(`/api/v1/customers/${id}`),
  createCustomer: (body: Json) => request("/api/v1/customers", { method: "POST", body }),
  customerSummary: (id: string) => request(`/api/v1/customers/${id}/summary`),
  customerSales: (id: string) => request(`/api/v1/customers/${id}/sales?limit=20`),
  customerPayments: (id: string) => request(`/api/v1/customers/${id}/payments?limit=20`),
  customerLedger: (id: string) => request(`/api/v1/customers/${id}/ledger?limit=30`),
  receivePayment: (id: string, body: Json, idempotencyKey: string) =>
    request(`/api/v1/customers/${id}/payments`, { method: "POST", body, idempotencyKey }),
  suppliers: (search: string, page: number) => request(`/api/v1/suppliers${query({ search, page, limit: 20 })}`),
  supplier: (id: string) => request(`/api/v1/suppliers/${id}`),
  createSupplier: (body: Json) => request("/api/v1/suppliers", { method: "POST", body }),
  paySupplier: (id: string, body: Json, idempotencyKey: string) =>
    request(`/api/v1/suppliers/${id}/payments`, { method: "POST", body, idempotencyKey }),
  purchases: (page: number) => request(`/api/v1/purchases${query({ page, limit: 20 })}`),
  purchase: (id: string) => request(`/api/v1/purchases/${id}`),
  createPurchase: (body: Json, idempotencyKey: string) =>
    request("/api/v1/purchases", { method: "POST", body, idempotencyKey }),
  createPurchaseReturn: (body: Json, idempotencyKey: string) =>
    request("/api/v1/purchases/returns", { method: "POST", body, idempotencyKey }),
  expenses: (page: number) => request(`/api/v1/expenses${query({ page, limit: 20 })}`),
  expenseSummary: () => request("/api/v1/expenses/summary?period=today"),
  expenseCategories: () => request("/api/v1/expenses/categories"),
  createExpense: (body: Json, idempotencyKey: string) =>
    request("/api/v1/expenses", { method: "POST", body, idempotencyKey }),
  reportSales: (period: string, from?: string, to?: string) =>
    request(`/api/v1/reports/sales${query({ period, from, to })}`),
  reportTopProducts: (period: string, from?: string, to?: string) =>
    request(`/api/v1/reports/products/top${query({ period, from, to, limit: 10, sort: "revenue" })}`),
  reportCustomers: (period: string) => request(`/api/v1/reports/customers${query({ period, limit: 10 })}`),
  reportOutstandingCustomers: () => request("/api/v1/reports/customers/outstanding?limit=10"),
  reportSuppliers: (period: string) => request(`/api/v1/reports/suppliers${query({ period, limit: 10 })}`),
  reportOutstandingSuppliers: () => request("/api/v1/reports/suppliers/outstanding?limit=10"),
  reportExpenses: (period: string, from?: string, to?: string) =>
    request(`/api/v1/reports/expenses${query({ period, from, to })}`),
  reportStock: () => request("/api/v1/reports/stock"),
  reportLow: (page = 1) => request(`/api/v1/reports/stock/low${query({ page, limit: 20 })}`),
  reportOut: (page = 1) => request(`/api/v1/reports/stock/out-of-stock${query({ page, limit: 20 })}`),
  reportInactive: (page = 1) => request(`/api/v1/reports/stock/inactive${query({ page, limit: 20 })}`),
  closingGet: (businessDate: string) => request(`/api/v1/daily-closing/${businessDate}`),
  closingClose: (businessDate: string) =>
    request("/api/v1/daily-closing", { method: "POST", body: { businessDate } }),
  closingRebuild: (businessDate: string) =>
    request(`/api/v1/daily-closing/${businessDate}/rebuild`, { method: "POST", body: {} }),
  intakeCreate: () => request("/api/v1/ai/intake", { method: "POST", body: { sourceType: "IMAGE" } }),
  intakeUploadUrl: (id: string, body: Json) => request(`/api/v1/ai/intake/${id}/upload-url`, { method: "POST", body }),
  intakeProcess: (id: string) => request(`/api/v1/ai/intake/${id}/process`, { method: "POST", body: {} }),
  intakeGet: (id: string) => request(`/api/v1/ai/intake/${id}`),
  intakeRetry: (id: string) => request(`/api/v1/ai/intake/${id}/retry`, { method: "POST", body: {} }),
  intakePatch: (id: string, itemId: string, body: Json) =>
    request(`/api/v1/ai/intake/${id}/items/${itemId}`, { method: "PATCH", body }),
  intakeReject: (id: string, itemId: string) =>
    request(`/api/v1/ai/intake/${id}/items/${itemId}/reject`, { method: "POST", body: {} }),
  intakeConfirm: (id: string, body: Json, idempotencyKey: string) =>
    request(`/api/v1/ai/intake/${id}/confirm`, { method: "POST", body, idempotencyKey }),
  uploadImage: putBytes,
};
