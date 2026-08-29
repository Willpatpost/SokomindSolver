import { useCallback, useEffect, useState } from "react";

export const LAB_PLAYBACK_SPEEDS = Object.freeze([0.5, 1, 2, 4] as const);

export function useLabPlayback(
  total: number,
  resetKey: string,
) {
  const [position, setPosition] = useState({
    key: resetKey,
    step: 0,
    playing: false,
  });
  const [speed, setSpeed] = useState(1);
  const current = position.key === resetKey
    ? position
    : { key: resetKey, step: 0, playing: false };
  const step = Math.min(current.step, total);
  const playing = current.playing && step < total;

  const updatePosition = useCallback((
    update: (value: { key: string; step: number; playing: boolean }) => {
      key: string;
      step: number;
      playing: boolean;
    },
  ) => {
    setPosition((value) => update(value.key === resetKey
      ? value
      : { key: resetKey, step: 0, playing: false }));
  }, [resetKey]);

  useEffect(() => {
    if (!playing || total === 0 || step >= total) return;
    const timer = window.setTimeout(() => {
      updatePosition((value) => {
        const next = Math.min(total, value.step + 1);
        return { ...value, step: next, playing: next < total };
      });
    }, Math.round(520 / speed));
    return () => window.clearTimeout(timer);
  }, [playing, speed, step, total, updatePosition]);

  const first = useCallback(() => {
    updatePosition((value) => ({ ...value, step: 0, playing: false }));
  }, [updatePosition]);
  const previous = useCallback(() => {
    updatePosition((value) => ({
      ...value,
      step: Math.max(0, Math.min(value.step, total) - 1),
      playing: false,
    }));
  }, [total, updatePosition]);
  const next = useCallback(() => {
    updatePosition((value) => ({
      ...value,
      step: Math.min(total, value.step + 1),
      playing: false,
    }));
  }, [total, updatePosition]);
  const last = useCallback(() => {
    updatePosition((value) => ({ ...value, step: total, playing: false }));
  }, [total, updatePosition]);
  const seek = useCallback((position: number) => {
    updatePosition((value) => ({
      ...value,
      step: Math.max(0, Math.min(total, Math.floor(position))),
      playing: false,
    }));
  }, [total, updatePosition]);
  const toggle = useCallback(() => {
    if (total === 0) return;
    updatePosition((value) => value.playing
      ? { ...value, playing: false }
      : {
          ...value,
          step: value.step >= total ? 0 : value.step,
          playing: true,
        });
  }, [total, updatePosition]);

  return {
    step,
    playing,
    speed,
    setSpeed,
    first,
    previous,
    next,
    last,
    seek,
    toggle,
  } as const;
}
