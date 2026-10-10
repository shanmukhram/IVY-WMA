import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { httpApi } from "./api.ts";
import { WsEvents } from "./events.ts";
import { Services } from "./ctx.tsx";
import { App } from "./App.tsx";
import "./style.css";

const events = new WsEvents();
events.start();
// a 423 anywhere means the vault locked (auto-lock or another window): re-check the key store
const api = httpApi("", (status) => { if (status === 423) window.dispatchEvent(new Event("ivy:locked")); });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Services.Provider value={{ api, events }}>
      <App />
    </Services.Provider>
  </StrictMode>,
);
