/**
 * Serialise syncs to Framer without ever reporting a stale one.
 *
 * At most one sync runs at a time: two concurrent passes could each compute a
 * stale set from the other's half-written state and remove live items. A
 * caller who arrives while a sync is running does NOT get that sync's result —
 * it read the list of published articles before the caller's change, so the
 * caller's article may not be in it. Instead the caller gets a follow-up sync
 * that starts once the current one settles, and so reads the database afresh.
 *
 * Everyone who arrives during one sync shares a single follow-up: a burst of
 * taps costs one extra pass, not one each. The follow-up is a forced rewrite if
 * any of them asked for one.
 */
export function createSyncLock<T>(run: (force: boolean) => Promise<T>): (force?: boolean) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  let next: { force: boolean; promise: Promise<T> } | null = null;

  const start = (force: boolean): Promise<T> => {
    const current: Promise<T> = Promise.resolve()
      .then(() => run(force))
      .finally(() => {
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  };

  return (force = false) => {
    // A queued follow-up is checked FIRST. Between the running sync settling
    // and the follow-up starting there are a few microtasks where nothing is
    // in flight; a caller landing there must join the follow-up, not start a
    // run beside it. Joining is correct — the follow-up reads the database
    // when it starts.
    if (next) {
      next.force = next.force || force;
      return next.promise;
    }
    if (!inFlight) return start(force);
    const waitingFor = inFlight;
    const queued: { force: boolean; promise: Promise<T> } = { force, promise: Promise.resolve() as Promise<T> };
    queued.promise = waitingFor
      .then(
        () => undefined,
        () => undefined
      )
      .then(() => {
        next = null;
        return start(queued.force);
      });
    next = queued;
    return queued.promise;
  };
}
