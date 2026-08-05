import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { configureVitePuzzleLoader } from "./catalog/configure-vite-puzzle-loader";
import { ExperienceProvider } from "./features/experience";
import { installCrossTabAppResetListener } from "./shared/app-data-reset";
import { notifyUpdateAvailable } from "./shared/sw-update-store";
import { ErrorBoundary } from "./shared/ui/ErrorBoundary";
import "./styles/globals.css";

const root = document.getElementById("root");

configureVitePuzzleLoader();
installCrossTabAppResetListener();

if (!root) {
  throw new Error("Sokomind could not find its application mount point.");
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <ExperienceProvider>
        <App />
      </ExperienceProvider>
    </ErrorBoundary>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    const workerUrl = new URL("sw.js", document.baseURI);
    const scope = new URL("./", document.baseURI).pathname;
    navigator.serviceWorker
      .register(workerUrl, { scope })
      .then((registration) => {
        if (registration.waiting) {
          notifyUpdateAvailable(registration.waiting);
        }

        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && registration.waiting) {
              notifyUpdateAvailable(registration.waiting);
            }
          });
        });
      })
      .catch(() => {});

    let hadController = Boolean(navigator.serviceWorker.controller);
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}
