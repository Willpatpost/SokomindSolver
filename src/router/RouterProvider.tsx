import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseHash } from "./parse-hash";
import { RouterContext, type RouterValue } from "./router-context";
import type { Route } from "./routes";

function resolveInitialRoute(): Route {
  const result = parseHash(window.location.hash);
  if (result.kind === "redirect") {
    window.location.replace(result.hash);
    const resolved = parseHash(result.hash);
    return resolved.kind === "route" ? resolved.route : { page: "home" };
  }
  return result.route;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [routing, setRouting] = useState(() => ({
    route: resolveInitialRoute(),
    previousRoute: null as Route | null,
  }));
  const { route, previousRoute } = routing;
  const prevPageRef = useRef(route.page);

  const commitRoute = useCallback((next: Route) => {
    setRouting((current) => ({
      route: next,
      previousRoute: current.route,
    }));
  }, []);

  const navigate = useCallback(
    (hash: string, options?: { replace?: boolean }) => {
      if (options?.replace) {
        window.history.replaceState(null, "", hash);
      } else {
        window.history.pushState(null, "", hash);
      }
      const result = parseHash(hash);
      if (result.kind === "redirect") {
        window.location.replace(result.hash);
        const resolved = parseHash(result.hash);
        if (resolved.kind === "route") commitRoute(resolved.route);
      } else {
        commitRoute(result.route);
      }
    },
    [commitRoute],
  );

  const back = useCallback(() => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate("#/");
    }
  }, [navigate]);

  useEffect(() => {
    function onHashChange() {
      const result = parseHash(window.location.hash);
      if (result.kind === "redirect") {
        window.location.replace(result.hash);
        const resolved = parseHash(result.hash);
        if (resolved.kind === "route") commitRoute(resolved.route);
      } else {
        commitRoute(result.route);
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [commitRoute]);

  useEffect(() => {
    if (prevPageRef.current !== route.page) {
      prevPageRef.current = route.page;
      const prefersReduced =
        document.documentElement.dataset.motion === "reduced" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({
        top: 0,
        behavior: prefersReduced ? "instant" : "smooth",
      });
    }
  }, [route.page]);

  const value = useMemo<RouterValue>(
    () => ({ route, previousRoute, navigate, back }),
    [route, previousRoute, navigate, back],
  );

  return (
    <RouterContext value={value}>
      {children}
    </RouterContext>
  );
}
