import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/600.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/router";
import { reportClientError } from "./lib/report-error";
import "./index.css";

window.addEventListener("error", (event) => {
  reportClientError(event.error instanceof Error ? event.error.message : "unhandled error");
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportClientError(reason instanceof Error ? reason.message : "unhandled rejection");
});

const saved = localStorage.getItem("dukaan.theme");
if (saved === "dark") {
  document.documentElement.dataset.theme = "dark";
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
