'use strict';

/**
 * A promise queue that serialises access to a resource.
 *
 * Node is single-threaded, but it is not atomic across `await` boundaries: two
 * requests can interleave in the middle of a read-modify-write and produce a
 * lost update. On a POS that means two tills billing at the same moment can be
 * assigned the same invoice number, or one order can overwrite the other in the
 * in-memory table. This is the primitive that makes "exactly one writer" true
 * in practice and not just in the architecture diagram.
 */
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
    this.queueDepth = 0;
  }

  /**
   * Run `fn` with exclusive access. Returns whatever `fn` returns. Errors
   * propagate to the caller but never break the chain for later waiters.
   */
  run(fn) {
    this.queueDepth += 1;
    const result = this._tail.then(fn, fn);
    // Swallow rejection on the chain itself so one failed write does not
    // poison every write that follows it.
    this._tail = result.then(
      () => undefined,
      () => undefined
    );
    return result.finally(() => {
      this.queueDepth -= 1;
    });
  }
}

module.exports = Mutex;
