import React from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { store } from "./store";
import App from "./App";
import { WidgetRegistryProvider } from "./widgets/registry";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

const root = createRoot(container);
root.render(
  <Provider store={store}>
    <WidgetRegistryProvider>
      <App />
    </WidgetRegistryProvider>
  </Provider>,
);
