const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const DEFAULT_BASE_PATH = "/Sokomind/";

function normalizeBasePath(value) {
  const url = new URL(value, "https://preview.invalid/");
  if (url.origin !== "https://preview.invalid") {
    throw new Error("SOKOMIND_PREVIEW_BASE_PATH must be a URL path, not an origin.");
  }
  const pathname = url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`;
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid SOKOMIND_PREVIEW_PORT: ${value}`);
  }
  return port;
}

export const PREVIEW_HOST = process.env.SOKOMIND_PREVIEW_HOST || DEFAULT_HOST;
export const PREVIEW_PORT = normalizePort(
  process.env.SOKOMIND_PREVIEW_PORT || DEFAULT_PORT,
);
export const PREVIEW_BASE_PATH = normalizeBasePath(
  process.env.SOKOMIND_PREVIEW_BASE_PATH || DEFAULT_BASE_PATH,
);
export const PREVIEW_URL = new URL(
  PREVIEW_BASE_PATH,
  `http://${PREVIEW_HOST}:${PREVIEW_PORT}`,
).href;
