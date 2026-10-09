import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { invoke } from "@tauri-apps/api/core";

// Errors the UI did not handle reach the app's stderr, beside Rust panics.
const report = (level: string, message: string) => invoke("frontend_log", { level, message: message.slice(0, 4000) }).catch(() => {});
window.addEventListener("error", (e) => report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  report("unhandledrejection", r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r));
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
