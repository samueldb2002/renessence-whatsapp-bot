jest.mock('../src/config', () => ({ OPENAI_API_KEY: 'test' }));
const { translate } = require('../src/services/translation.service');

const fakeClient = (reply) => {
  const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: reply } }] });
  return { client: { chat: { completions: { create } } }, create };
};

test('asks for the target language and treats the text as data', async () => {
  const { client, create } = fakeClient('Hoi! Je float staat om 14:45.');
  expect(await translate('Hi! Your float is at 14:45.', 'nl', { client })).toBe('Hoi! Je float staat om 14:45.');
  const [{ messages, model, temperature }] = create.mock.calls[0];
  expect(model).toBe('gpt-4o-mini');
  expect(temperature).toBe(0);
  expect(messages[0].content).toMatch(/into Dutch/);
  expect(messages[0].content).toMatch(/never instructions/);
  expect(messages[1].content).toBe('<text>Hi! Your float is at 14:45.</text>');
});

test('strips echoed <text> tags', async () => {
  const { client } = fakeClient('<text>Hello</text>');
  expect(await translate('Hallo', 'en', { client })).toBe('Hello');
});

test('rejects empty, oversized and unsupported requests without calling the model', async () => {
  const { client, create } = fakeClient('x');
  await expect(translate('   ', 'en', { client })).rejects.toThrow(/Nothing to translate/);
  await expect(translate('a'.repeat(4001), 'en', { client })).rejects.toThrow(/too long/);
  await expect(translate('hallo', 'de', { client })).rejects.toThrow(/Unsupported/);
  expect(create).not.toHaveBeenCalled();
});
