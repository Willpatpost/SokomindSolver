import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StablePriorityQueue } from "../../src/solver/search/priority-queue.ts";

describe("StablePriorityQueue", () => {
  it("empty is true on a new queue", () => {
    const q = new StablePriorityQueue<number>((a, b) => a - b);
    assert.equal(q.empty, true);
  });

  it("empty is false after enqueue", () => {
    const q = new StablePriorityQueue<number>((a, b) => a - b);
    q.enqueue(5);
    assert.equal(q.empty, false);
  });

  it("peek returns the minimum without removing it", () => {
    const q = new StablePriorityQueue<number>((a, b) => a - b);
    q.enqueue(10);
    q.enqueue(3);
    q.enqueue(7);
    assert.equal(q.peek(), 3);
    assert.equal(q.size, 3);
  });

  it("peek returns undefined on empty queue", () => {
    const q = new StablePriorityQueue<number>((a, b) => a - b);
    assert.equal(q.peek(), undefined);
  });

  it("clear empties the queue", () => {
    const q = new StablePriorityQueue<number>((a, b) => a - b);
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3);
    assert.equal(q.size, 3);
    q.clear();
    assert.equal(q.size, 0);
    assert.equal(q.empty, true);
    assert.equal(q.peek(), undefined);
  });
});
