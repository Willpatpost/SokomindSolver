export const GLYPH: Readonly<Record<string, string>> = { U: "↑", D: "↓", L: "←", R: "→" };
export const MAX_VISIBLE = 24;

export interface FormattedNotation {
  readonly glyphs: readonly string[];
  readonly truncated: boolean;
  readonly offset: number;
}

export function formatActionLog(actionLog: string): FormattedNotation {
  const visible = actionLog.length > MAX_VISIBLE ? actionLog.slice(-MAX_VISIBLE) : actionLog;
  const truncated = actionLog.length > MAX_VISIBLE;
  const offset = actionLog.length - visible.length;
  const glyphs = [...visible].map(code => GLYPH[code] ?? code);
  return { glyphs, truncated, offset };
}
