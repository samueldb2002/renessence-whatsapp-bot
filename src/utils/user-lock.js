// Per-customer serialisation of agent runs. A customer's live message and a
// catch-up replay must never run the agent concurrently for the same phone —
// that produced duplicate bookings and slot races when it happened per turn.
const userLocks = new Map();

function withUserLock(phone, fn) {
  const prev = userLocks.get(phone) || Promise.resolve();
  const current = prev.then(fn, fn);
  userLocks.set(phone, current);
  // Clean up on both outcomes WITHOUT creating a second rejected promise:
  // `.finally()` re-throws the rejection into a promise nobody awaits, which
  // Node 20 reports as an unhandled rejection (it crashed the test runner).
  const release = () => { if (userLocks.get(phone) === current) userLocks.delete(phone); };
  current.then(release, release);
  return current;
}

module.exports = { withUserLock };
