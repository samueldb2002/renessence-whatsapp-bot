// The prompt must describe massages/facials as paid BEFORE booking and never
// carry the old book-first wording for them ("reserved … complete payment").
const { buildSystemPrompt } = require('../src/agents/system-prompt');

const prompt = buildSystemPrompt('31600000001', 'Sanne');

test('has the pay-first section and the new summary buttons in both languages', () => {
  expect(prompt).toMatch(/## Pay-first treatments/);
  expect(prompt).toMatch(/"title":"Confirm & pay"/);
  expect(prompt).toMatch(/Bevestig & betaal/);
  expect(prompt).toMatch(/online te betalen; je afspraak staat vast zodra de betaling rond is/);
});

test('massages are no longer described as booked first and paid after', () => {
  expect(prompt).not.toMatch(/These are paid online before the visit: Massages/);
  expect(prompt).not.toMatch(/another booking just took it/);
});

test('the live pay-first state goes in the Session tail, not the shared body', () => {
  const withStatus = buildSystemPrompt('31600000001', 'Sanne', false, false, { payFirstStatus: 'Tailored Massage 60 min, Friday 16 October at 14:00: AWAITING PAYMENT' });
  const session = withStatus.lastIndexOf('## Session');
  const line = withStatus.indexOf('Pay-first bookings of this customer:');
  expect(line).toBeGreaterThan(session);
  expect(prompt).not.toMatch(/Pay-first bookings of this customer:/);
});
