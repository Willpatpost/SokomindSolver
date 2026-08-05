import { createContext } from "react";
import type { Route } from "./routes";

export interface RouterValue {
  readonly route: Route;
  readonly previousRoute: Route | null;
  readonly navigate: (hash: string, options?: { replace?: boolean }) => void;
  readonly back: () => void;
}

export const RouterContext = createContext<RouterValue | null>(null);
