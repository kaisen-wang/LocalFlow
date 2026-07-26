import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import QuickCapture from "./QuickCapture";

document.addEventListener("contextmenu", (e) => e.preventDefault());

async function boot() {
  let Root = App;
  try {
    // 仅在 Tauri WebView 内可用；Vite 纯前端预览时回退到主界面
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    if (getCurrentWindow().label === "quick-capture") {
      Root = QuickCapture;
    }
  } catch {
    Root = App;
  }

  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

boot();
