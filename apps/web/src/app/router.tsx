import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, type ReactNode } from "react";
import { createBrowserRouter, RouterProvider, type RouteObject } from "react-router";
import { RequireAuth, RequireShop, Shell } from "../components/shell";
import { ClosingPage } from "../pages/closing";
import { CustomerDetailPage, CustomersPage } from "../pages/customers";
import { DashboardPage } from "../pages/dashboard";
import { ExpensesPage } from "../pages/expenses";
import { IntakePage } from "../pages/intake";
import { LoginPage } from "../pages/login";
import { MastersPage } from "../pages/masters";
import { MorePage } from "../pages/more";
import { ProductDetailPage, ProductFormPage, ProductsPage } from "../pages/products";
import { NewPurchasePage, PurchaseDetailPage, PurchasesPage } from "../pages/purchases";
import { ReportsPage } from "../pages/reports";
import { SaleDetailPage, SalesPage } from "../pages/sales";
import { SellPage } from "../pages/sell";
import { SettingsPage } from "../pages/settings";
import { ShopsPage } from "../pages/shops";
import { AddStockPage, StockPage } from "../pages/stock";
import { SupplierDetailPage, SuppliersPage } from "../pages/suppliers";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false },
      mutations: { retry: 0 },
    },
  });
}

export const routes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    path: "/shops",
    element: (
      <RequireAuth>
        <ShopsPage />
      </RequireAuth>
    ),
  },
  {
    element: (
      <RequireShop>
        <Shell />
      </RequireShop>
    ),
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/dashboard", element: <DashboardPage /> },
      { path: "/sell", element: <SellPage /> },
      { path: "/products", element: <ProductsPage /> },
      { path: "/products/new", element: <ProductFormPage /> },
      { path: "/products/:productId", element: <ProductDetailPage /> },
      { path: "/stock", element: <StockPage /> },
      { path: "/stock/add", element: <AddStockPage /> },
      { path: "/customers", element: <CustomersPage /> },
      { path: "/customers/:customerId", element: <CustomerDetailPage /> },
      { path: "/purchases", element: <PurchasesPage /> },
      { path: "/purchases/new", element: <NewPurchasePage /> },
      { path: "/purchases/:purchaseId", element: <PurchaseDetailPage /> },
      { path: "/suppliers", element: <SuppliersPage /> },
      { path: "/suppliers/:supplierId", element: <SupplierDetailPage /> },
      { path: "/sales", element: <SalesPage /> },
      { path: "/sales/:saleId", element: <SaleDetailPage /> },
      { path: "/expenses", element: <ExpensesPage /> },
      { path: "/reports", element: <ReportsPage /> },
      { path: "/daily-closing", element: <ClosingPage /> },
      { path: "/ai", element: <IntakePage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "/more", element: <MorePage /> },
      { path: "/masters", element: <MastersPage /> },
    ],
  },
];

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ShopBoundary>
      <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>
    </ShopBoundary>
  );
}

export function App() {
  return (
    <AppProviders>
      <RouterProvider router={createBrowserRouter(routes)} />
    </AppProviders>
  );
}

class ShopBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-4">
          <h1 className="text-2xl font-semibold">Something went wrong.</h1>
          <p>Please refresh the page.</p>
          <button type="button" className="min-h-12 rounded-xl bg-accent font-semibold text-accent-ink" onClick={() => window.location.reload()}>
            Refresh
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
