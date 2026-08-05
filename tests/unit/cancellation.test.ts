import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSolverCancellationController,
  isSolverCancellation,
  SolverCancelledError,
  throwIfSolverCancelled,
} from "../../src/solver/cancellation.ts";

describe("SolverCancelledError", () => {
  it("has the correct name, code, and default message", () => {
    const error = new SolverCancelledError();
    assert.equal(error.name, "SolverCancelledError");
    assert.equal(error.code, "SOLVER_CANCELLED");
    assert.equal(error.message, "Solver run cancelled");
    assert.ok(error instanceof Error);
  });

  it("accepts a custom message", () => {
    const error = new SolverCancelledError("custom reason");
    assert.equal(error.message, "custom reason");
    assert.equal(error.code, "SOLVER_CANCELLED");
  });
});

describe("throwIfSolverCancelled", () => {
  it("does not throw when the signal is not aborted", () => {
    const controller = new AbortController();
    assert.doesNotThrow(() => throwIfSolverCancelled(controller.signal));
  });

  it("throws SolverCancelledError when the signal is aborted", () => {
    const controller = new AbortController();
    controller.abort("test reason");
    assert.throws(
      () => throwIfSolverCancelled(controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof SolverCancelledError);
        assert.equal(error.message, "test reason");
        return true;
      },
    );
  });

  it("uses default message when abort reason is empty", () => {
    const controller = new AbortController();
    controller.abort("   ");
    assert.throws(
      () => throwIfSolverCancelled(controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof SolverCancelledError);
        assert.equal(error.message, "Solver run cancelled");
        return true;
      },
    );
  });

  it("uses default message when abort reason is not a string", () => {
    const controller = new AbortController();
    controller.abort(42);
    assert.throws(
      () => throwIfSolverCancelled(controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof SolverCancelledError);
        assert.equal(error.message, "Solver run cancelled");
        return true;
      },
    );
  });
});

describe("isSolverCancellation", () => {
  it("identifies SolverCancelledError instances", () => {
    assert.equal(isSolverCancellation(new SolverCancelledError()), true);
  });

  it("identifies errors with name 'AbortError'", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    assert.equal(isSolverCancellation(error), true);
  });

  it("identifies errors with code 'ABORT_ERR'", () => {
    const error = new Error("aborted") as Error & { code: string };
    error.code = "ABORT_ERR";
    assert.equal(isSolverCancellation(error), true);
  });

  it("rejects non-cancellation errors", () => {
    assert.equal(isSolverCancellation(new Error("random")), false);
    assert.equal(isSolverCancellation(new TypeError("type")), false);
  });

  it("rejects non-Error values", () => {
    assert.equal(isSolverCancellation(null), false);
    assert.equal(isSolverCancellation(undefined), false);
    assert.equal(isSolverCancellation("string"), false);
    assert.equal(isSolverCancellation(42), false);
  });
});

describe("createSolverCancellationController", () => {
  it("creates a controller with a non-aborted signal", () => {
    const ctrl = createSolverCancellationController();
    assert.equal(ctrl.signal.aborted, false);
  });

  it("cancels with the default message", () => {
    const ctrl = createSolverCancellationController();
    ctrl.cancel();
    assert.equal(ctrl.signal.aborted, true);
    assert.equal(ctrl.signal.reason, "Solver run cancelled");
  });

  it("cancels with a custom reason", () => {
    const ctrl = createSolverCancellationController();
    ctrl.cancel("user stopped");
    assert.equal(ctrl.signal.aborted, true);
    assert.equal(ctrl.signal.reason, "user stopped");
  });

  it("cancel is idempotent — second call does not change the reason", () => {
    const ctrl = createSolverCancellationController();
    ctrl.cancel("first");
    ctrl.cancel("second");
    assert.equal(ctrl.signal.reason, "first");
  });

  it("propagates cancellation from a parent signal", () => {
    const parent = new AbortController();
    const ctrl = createSolverCancellationController(parent.signal);
    assert.equal(ctrl.signal.aborted, false);

    parent.abort("parent done");
    assert.equal(ctrl.signal.aborted, true);
    assert.equal(ctrl.signal.reason, "parent done");
  });

  it("is immediately cancelled when the parent is already aborted", () => {
    const parent = new AbortController();
    parent.abort("already");
    const ctrl = createSolverCancellationController(parent.signal);
    assert.equal(ctrl.signal.aborted, true);
  });

  it("dispose prevents parent propagation", () => {
    const parent = new AbortController();
    const ctrl = createSolverCancellationController(parent.signal);
    ctrl.dispose();

    parent.abort("late");
    // The child should not be aborted because we disposed the listener.
    assert.equal(ctrl.signal.aborted, false);
  });

  it("works without a parent signal", () => {
    const ctrl = createSolverCancellationController(undefined);
    assert.equal(ctrl.signal.aborted, false);
    ctrl.cancel("done");
    assert.equal(ctrl.signal.aborted, true);
    // dispose is safe to call even without a parent.
    ctrl.dispose();
  });

  it("signal integrates with throwIfSolverCancelled", () => {
    const ctrl = createSolverCancellationController();
    assert.doesNotThrow(() => throwIfSolverCancelled(ctrl.signal));

    ctrl.cancel("stop");
    assert.throws(
      () => throwIfSolverCancelled(ctrl.signal),
      (error: unknown) => {
        assert.ok(error instanceof SolverCancelledError);
        assert.equal(error.message, "stop");
        return true;
      },
    );
  });

  it("signal integrates with SolverExecutionContext contract", () => {
    // Verify that the signal property satisfies the AbortSignal interface
    // expected by SolverExecutionContext.
    const ctrl = createSolverCancellationController();
    const context = {
      signal: ctrl.signal,
      reportProgress: () => {},
      now: () => performance.now(),
    };
    assert.equal(context.signal.aborted, false);
    ctrl.cancel();
    assert.equal(context.signal.aborted, true);
  });
});
