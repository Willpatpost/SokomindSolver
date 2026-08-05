import { lazy, Suspense, useEffect, useRef } from "react";
import { useRouter, type Route } from "@/src/router";

const HomePage = lazy(() =>
  import("@/src/features/home/HomePage").then((m) => ({ default: m.HomePage })),
);
const PuzzleSelectorPage = lazy(() =>
  import("@/src/features/selector/PuzzleSelectorPage").then((m) => ({
    default: m.PuzzleSelectorPage,
  })),
);
const PlayPage = lazy(() =>
  import("@/src/features/play/PlayPage").then((m) => ({ default: m.PlayPage })),
);
const EditorPage = lazy(() =>
  import("@/src/features/editor-page/EditorPage").then((m) => ({
    default: m.EditorPage,
  })),
);

const PAGE_LABELS: Record<string, string> = {
  home: "Home",
  puzzles: "Puzzles",
  "puzzles-difficulty": "Puzzles",
  "puzzles-collection": "Puzzles",
  play: "Play",
  editor: "Editor",
};

function routeIdentity(route: Route): string {
  switch (route.page) {
    case "home":
    case "puzzles":
      return route.page;
    case "puzzles-difficulty":
      return `${route.page}:${route.difficulty}`;
    case "puzzles-collection":
      return `${route.page}:${route.difficulty}:${route.collection}`;
    case "play":
      return `${route.page}:${route.puzzleId}:${route.actionLog ?? ""}`;
    case "editor":
      return route.page;
  }
}

function LoadingFallback() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "3rem" }}>
      <span aria-busy="true">Loading...</span>
    </div>
  );
}

export function AppShell() {
  const { previousRoute, route } = useRouter();
  const announcerRef = useRef<HTMLDivElement>(null);
  const identity = routeIdentity(route);
  const previousIdentityRef = useRef(identity);
  const freshPlayAttempt =
    route.page === "play" &&
    previousRoute?.page === "play" &&
    previousRoute.puzzleId !== route.puzzleId;

  useEffect(() => {
    if (previousIdentityRef.current === identity) return;
    previousIdentityRef.current = identity;

    const announcer = announcerRef.current;
    if (!announcer) return;
    const liveAnnouncer: HTMLDivElement = announcer;
    liveAnnouncer.textContent = "";

    let settled = false;
    function announceAndFocus(): boolean {
      const routeRoot = [...document.querySelectorAll<HTMLElement>(
        "[data-route-identity]",
      )].find((candidate) => candidate.dataset.routeIdentity === identity);
      const heading = routeRoot?.querySelector<HTMLElement>("main h1");
      if (!heading || heading.getClientRects().length === 0) return false;

      settled = true;
      const label =
        heading.textContent?.trim() || PAGE_LABELS[route.page] || route.page;
      liveAnnouncer.textContent = `Navigated to ${label}`;
      if (!heading.hasAttribute("tabindex")) {
        heading.setAttribute("tabindex", "-1");
      }
      heading.focus();
      return true;
    }

    if (announceAndFocus()) return;

    const root = document.getElementById("root");
    const observer = new MutationObserver(() => {
      if (announceAndFocus()) observer.disconnect();
    });
    observer.observe(root ?? document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    const timeout = window.setTimeout(() => {
      observer.disconnect();
      if (!settled) {
        liveAnnouncer.textContent = `Navigated to ${PAGE_LABELS[route.page] ?? route.page}`;
      }
    }, 2_000);

    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [identity, route.page]);

  return (
    <>
      <div
        ref={announcerRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
      <Suspense fallback={<LoadingFallback />}>
        <div
          key={identity}
          data-route-identity={identity}
          style={{ display: "contents" }}
        >
          {route.page === "home" && <HomePage />}
          {(route.page === "puzzles" ||
            route.page === "puzzles-difficulty" ||
            route.page === "puzzles-collection") && (
            <PuzzleSelectorPage route={route} />
          )}
          {route.page === "play" && (
            <PlayPage
              key={`${route.puzzleId}:${route.actionLog ?? ""}`}
              puzzleId={route.puzzleId}
              actionLog={route.actionLog}
              freshAttempt={freshPlayAttempt}
            />
          )}
          {route.page === "editor" && <EditorPage customData={route.customData} />}
        </div>
      </Suspense>
    </>
  );
}
