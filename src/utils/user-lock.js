// Per-customer serialisation. Each lock is a promise chain per phone: the next
// job starts when the previous one has finished (whether it failed or not).
function makeLock() {
  const locks = new Map();
  return function withLock(phone, fn) {
    const prev = locks.get(phone) || Promise.resolve();
    const current = prev.then(fn, fn);
    locks.set(phone, current);
    // Clean up on both outcomes WITHOUT creating a second rejected promise:
    // `.finally()` re-throws the rejection into a promise nobody awaits, which
    // Node 20 reports as an unhandled rejection (it crashed the test runner).
    const release = () => { if (locks.get(phone) === current) locks.delete(phone); };
    current.then(release, release);
    return current;
  };
}

// Agent runs: a customer's live message and a catch-up replay must never run
// the agent concurrently for the same phone — that produced duplicate bookings
// and slot races when it happened per turn.
const withUserLock = makeLock();

// Team sends to one guest (parked replies, direct replies, payment links) and
// cancelling parked replies: one at a time per guest, so a direct reply can't
// overtake parked ones that are still being sent and a cancel can't land in
// the middle of a delivery. Separate from the agent lock, so a team send never
// waits for an AI turn. Not re-entrant: never take it twice in one call chain.
const withSendLock = makeLock();

module.exports = { withUserLock, withSendLock };
