import { test } from "node:test";

test("isolated child loads the requested module", () => {
  console.info("isolated-performance-child-ran");
  console.info(
    `isolated-performance-child-mode=${process.env.NODE_TEST_CONTEXT ?? "direct"}`,
  );
});
