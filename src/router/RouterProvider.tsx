import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parentHash } from "./navigation";
import { resolveHash } from "./parse-hash";
import { RouterContext, type RouterValue } from "./router-context";
import type { Route } from "./routes";

/**
 * The number of app pages before a history entry, stored in the entries the
 * router writes. back() uses it to avoid leaving for a page the tab showed
 * before the app.
 */
function readDepth(state: unknown): number | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const depth = (state as { sokomindDepth?: unknown }).sokomindDepth;
  return typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0
    ? depth
    : undefined;
}

function historyState(depth: number): { sokomindDepth: number } {
  return { sokomindDepth: depth };
}

// A redirect is written with replaceState, which unlike location.replace
// fires no hashchange, so the route commits once.
function resolveInitialRoute(): { route: Route; depth: number } {
  const { route, hash } = resolveHash(window.location.hash);
  // A reload keeps the entry's depth; any other first entry is the app's first.
  const depth = readDepth(window.history.state) ?? 0;
  window.history.replaceState(
    historyState(depth),
    "",
    hash === window.location.hash ? undefined : hash,
  );
  return { route, depth };
}

function isPuzzleSelectorRoute(route: Route): boolean {
  return route.page === "puzzles" ||
    route.page === "puzzles-difficulty" ||
    route.page === "puzzles-collection";
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(resolveInitialRoute);
  const [routing, setRouting] = useState(() => ({
    route: initial.route,
    previousRoute: null as Route | null,
    puzzlesReturnHash: isPuzzleSelectorRoute(initial.route)
      ? window.location.hash
      : "#/puzzles",
  }));
  const { route, previousRoute, puzzlesReturnHash } = routing;
  const prevPageRef = useRef(route.page);
  // The current entry's depth. Entries the router did not write have none, so
  // this is what a new one continues from.
  const depthRef = useRef(initial.depth);

  const commitRoute = useCallback((next: Route, hash = window.location.hash) => {
    setRouting((current) => ({
      route: next,
      previousRoute: current.route,
      puzzlesReturnHash: isPuzzleSelectorRoute(next)
        ? hash
        : current.puzzlesReturnHash,
    }));
  }, []);

  const navigate = useCallback(
    (hash: string, options?: { replace?: boolean }) => {
      const resolved = resolveHash(hash);
      if (options?.replace) {
        window.history.replaceState(historyState(depthRef.current), "", resolved.hash);
      } else {
        depthRef.current += 1;
        window.history.pushState(historyState(depthRef.current), "", resolved.hash);
      }
      commitRoute(resolved.route, resolved.hash);
    },
    [commitRoute],
  );

  // history.length also counts pages from before the app, so only an entry
  // with app pages behind it steps back; otherwise go up one level in place.
  const back = useCallback(() => {
    if ((readDepth(window.history.state) ?? 0) > 0) {
      window.history.back();
    } else {
      navigate(parentHash(route, puzzlesReturnHash), { replace: true });
    }
  }, [navigate, puzzlesReturnHash, route]);

  useEffect(() => {
    // Traversals land on entries that carry their depth. An entry without one
    // came from a fragment navigation the router did not make (a plain hash
    // assignment or the address bar), which adds an entry after the current one.
    function syncDepth() {
      const depth = readDepth(window.history.state);
      if (depth !== undefined) {
        depthRef.current = depth;
      } else {
        depthRef.current += 1;
        window.history.replaceState(historyState(depthRef.current), "");
      }
    }
    function onHashChange() {
      syncDepth();
      const { route: next, hash } = resolveHash(window.location.hash);
      if (hash !== window.location.hash) {
        window.history.replaceState(window.history.state, "", hash);
      }
      commitRoute(next, hash);
    }
    window.addEventListener("popstate", syncDepth);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("popstate", syncDepth);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [commitRoute]);

  useEffect(() => {
    if (prevPageRef.current !== route.page) {
      prevPageRef.current = route.page;
      if (previousRoute?.page === "play" && isPuzzleSelectorRoute(route)) {
        return;
      }
      const prefersReduced =
        document.documentElement.dataset.motion === "reduced" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({
        top: 0,
        behavior: prefersReduced ? "instant" : "smooth",
      });
    }
  }, [previousRoute, route]);

  const value = useMemo<RouterValue>(
    () => ({
      route,
      previousRoute,
      puzzlesReturnHash,
      navigate,
      back,
    }),
    [route, previousRoute, puzzlesReturnHash, navigate, back],
  );

  return (
    <RouterContext value={value}>
      {children}
    </RouterContext>
  );
}
