import assert from "node:assert/strict";
import test from "node:test";

import { hintUnsolvedMessage } from "../../src/features/game/hint-messages.ts";

test("hint failures explain exhausted, bounded, and unsupported searches distinctly", () => {
  const exhausted = hintUnsolvedMessage("exhausted");
  const limited = hintUnsolvedMessage("limit-reached");
  const unsupported = hintUnsolvedMessage("unsupported");

  assert.match(exhausted, /no solution/i);
  assert.match(limited, /limit/i);
  assert.match(unsupported, /not supported/i);
  assert.equal(new Set([exhausted, limited, unsupported]).size, 3);
});
