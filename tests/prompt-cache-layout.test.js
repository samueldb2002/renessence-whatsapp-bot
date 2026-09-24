// OpenAI bills cached input tokens at half price, but only for the longest
// prefix that is byte-identical between calls. With the customer line at the
// top of the system prompt nothing beyond it was ever shared. This pins the
// layout: everything session-specific sits at the END.

jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ checkout: { sessions: {} }, webhooks: {} })));

const { buildSystemPrompt } = require('../src/agents/system-prompt');

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

test('two different customers share ≥ 98% of the prompt as an identical prefix', () => {
  const alice = buildSystemPrompt('31611111111', 'Alice');
  const bob = buildSystemPrompt('31622222222', 'Bob', true, false);
  const shared = commonPrefixLength(alice, bob);
  expect(shared / Math.min(alice.length, bob.length)).toBeGreaterThan(0.98);
});

test('the session facts are at the end and still complete', () => {
  const p = buildSystemPrompt('31611111111', 'Alice', true, true);
  const session = p.lastIndexOf('\n## Session\n');
  expect(session).toBeGreaterThan(p.length * 0.9);
  const tail = p.slice(session);
  expect(tail).toMatch(/Customer: Alice \| Phone: 31611111111/);
  expect(tail).toMatch(/Today: \d{4}-\d{2}-\d{2} \| Tomorrow: \d{4}-\d{2}-\d{2}/);
  expect(tail).toMatch(/CONTINUING CONVERSATION/);
  expect(tail).toMatch(/HISTORY UNAVAILABLE/);
  expect(p.indexOf('Customer: Alice')).toBeGreaterThan(p.indexOf('## Knowledge base'));
});

test('date-dependent rules point at the Session section, not "the top"', () => {
  const p = buildSystemPrompt('31611111111', 'Alice');
  expect(p).not.toMatch(/top of this prompt/);
  expect(p).toMatch(/Session section at the end of this prompt/);
});

test('web sessions get the web-chat block in the tail', () => {
  const p = buildSystemPrompt('web_abc', 'Guest');
  expect(p.slice(p.lastIndexOf('\n## Session\n'))).toMatch(/## Web chat/);
  expect(p.startsWith('You are the website assistant')).toBe(true);
});
