import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { invoke } from "@tauri-apps/api/core";
import { FloatingAgent } from "./components/FloatingAgent";
import { FloatingView, type FloatableView } from "./components/FloatingView";
import { devEnv } from "./lib/dev";

// Errors the UI did not handle reach the app's stderr, beside Rust panics.
const report = (level: string, message: string) => invoke("frontend_log", { level, message: message.slice(0, 4000) }).catch(() => {});
window.addEventListener("error", (e) => report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  report("unhandledrejection", r instanceof Error ? `${r.message}\n${r.stack ?? ""}` : String(r));
});

// With the window hidden, endless animations (working spinners, breathing dots) stop: a
// hidden page would still drive frames for them (index.css, [data-hidden]).
const markHidden = () => document.documentElement.toggleAttribute("data-hidden", document.hidden);
document.addEventListener("visibilitychange", markHidden);
markHidden();

// A floating window (float.rs) is told which agent it shows; a preview can draw one in its
// own window for a screenshot (OPENADMIRAL_VIEW=float:<id>).
const render = (float?: string) =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>{float?.startsWith("view-") ? <FloatingView view={float.slice(5) as FloatableView} /> : float ? <FloatingAgent id={float} /> : <App />}</React.StrictMode>,
  );
const told = (window as { __OPENADMIRAL_FLOAT__?: string }).__OPENADMIRAL_FLOAT__;
if (told) render(told);
else devEnv.then((d) => render(d.view?.startsWith("float:") ? d.view.slice(6) : undefined));
