import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installGlobalErrorLogging } from "./lib/logger";
import "./index.css";

installGlobalErrorLogging();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary scope="application" fullScreen>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
