import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "DukaanOS",
        short_name: "DukaanOS",
        description: "Shop app for Indian retailers",
        theme_color: "#1c1917",
        background_color: "#f4efe6",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173 },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
