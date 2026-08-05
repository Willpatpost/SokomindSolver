import { useContext } from "react";
import { RouterContext, type RouterValue } from "./router-context";

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) {
    throw new Error("useRouter must be used within a RouterProvider.");
  }
  return value;
}
