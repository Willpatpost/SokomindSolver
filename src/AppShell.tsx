import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, type Route } from "@/src/router";
import { MobileNav } from "@/src/features/navigation/MobileNav";
import { ScrollToTop } from "@/src/shared/ui/ScrollToTop";
import { LoadingSkeleton } from "@/src/shared/ui/LoadingSkeleton";
import { NetworkStatus } from "@/src/shared/ui/NetworkStatus";

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
const StatsPage = lazy(() =>
  import("@/src/features/stats/StatsPage").then((m) => ({
    default: m.StatsPage,
  })),
);

const PAGE_LABELS: Record<string, string> = {
  home: "Home",
  puzzles: "Puzzles",
  "puzzles-difficulty": "Puzzles",
  "puzzles-collection": "Puzzles",
  play: "Play",
  editor: "Editor",
  stats: "Statistics",
};

const PAGE_DEPTH: Record<string, number> = {
  home: 0,
  puzzles: 1,
  "puzzles-difficulty": 2,
  "puzzles-collection": 3,
  play: 3,
  editor: 1,
  stats: 1,
};

function routeIdentity(route: Route): string {
  switch (route.page) {
    case "home":
    case "puzzles":
    case "stats":
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
  return <LoadingSkeleton />;
}

export function AppShell() {
  const { previousRoute, route, back } = useRouter();
  const announcerRef = useRef<HTMLDivElement>(null);
  const identity = routeIdentity(route);
  const previousIdentityRef = useRef(identity);
  const freshPlayAttempt =
    route.page === "play" &&
    previousRoute?.page === "play" &&
    previousRoute.puzzleId !== route.puzzleId;

  const handleEscapeBack = useCallback(
    (event: KeyboardEvent) => {
      if (
        route.page === "home" ||
        event.defaultPrevented ||
        event.key !== "Escape" ||
        document.querySelector("dialog[open], [role='dialog']")
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) {
        return;
      }
      event.preventDefault();
      back();
    },
    [route.page, back],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleEscapeBack);
    return () => window.removeEventListener("keydown", handleEscapeBack);
  }, [handleEscapeBack]);

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
      heading.dataset.routeFocusTarget = "";
      heading.focus({ preventScroll: true });
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

  const [transitionClass, setTransitionClass] = useState("page-enter-active");
  const previousPageRef = useRef(route.page);

  useEffect(() => {
    if (previousPageRef.current === route.page) return;
    const prevDepth = PAGE_DEPTH[previousPageRef.current] ?? 0;
    const nextDepth = PAGE_DEPTH[route.page] ?? 0;
    previousPageRef.current = route.page;
    const direction = nextDepth >= prevDepth ? "page-enter-forward" : "page-enter-back";
    setTransitionClass(direction);
    const frame = requestAnimationFrame(() => {
      setTransitionClass("page-enter-active");
    });
    return () => cancelAnimationFrame(frame);
  }, [route.page]);

  const skipToMain = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const main = document.querySelector<HTMLElement>("main");
      if (main) {
        if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
        main.focus();
      }
    },
    [],
  );

  return (
    <>
      <a href="#main" className="skip-to-content" onClick={skipToMain}>
        Skip to content
      </a>
      <div
        ref={announcerRef}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
      <NetworkStatus />
      <Suspense fallback={<LoadingFallback />}>
        <div
          key={identity}
          data-route-identity={identity}
          className={transitionClass}
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
          {route.page === "stats" && <StatsPage />}
        </div>
      </Suspense>
      <MobileNav />
      <ScrollToTop />
    </>
  );
}
