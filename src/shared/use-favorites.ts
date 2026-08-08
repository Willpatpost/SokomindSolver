import { useCallback, useEffect, useState } from "react";
import { loadFavorites, toggleFavorite, type FavoriteSet } from "./favorites";
import { STORAGE_KEYS } from "./storage";

export function useFavorites(): {
  favorites: FavoriteSet;
  isFavorite: (id: string) => boolean;
  toggle: (id: string) => boolean;
} {
  const [favorites, setFavorites] = useState<FavoriteSet>(loadFavorites);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.favorites) return;
      setFavorites(loadFavorites());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const isFavorite = useCallback(
    (id: string) => favorites.has(id),
    [favorites],
  );

  const toggle = useCallback((id: string): boolean => {
    const result = toggleFavorite(id);
    setFavorites(result.favorites);
    return result.isFavorite;
  }, []);

  return { favorites, isFavorite, toggle };
}
