const TTL = 30 * 60 * 1000; // 30 minutes
const conversations = new Map();

function get(phoneNumber) {
  const conv = conversations.get(phoneNumber);
  if (!conv) return null;
  if (Date.now() - conv.lastActivity > TTL) {
    conversations.delete(phoneNumber);
    return null;
  }
  conv.lastActivity = Date.now();
  return conv;
}

function set(phoneNumber, data) {
  const existing = conversations.get(phoneNumber) || {};
  conversations.set(phoneNumber, {
    ...existing,
    ...data,
    phoneNumber,
    lastActivity: Date.now(),
  });
}

function update(phoneNumber, updates) {
  const conv = get(phoneNumber);
  if (!conv) return null;
  const updated = { ...conv, ...updates, lastActivity: Date.now() };
  conversations.set(phoneNumber, updated);
  return updated;
}

function clear(phoneNumber) {
  conversations.delete(phoneNumber);
}

function startFlow(phoneNumber, flowName, initialData = {}) {
  set(phoneNumber, {
    activeFlow: flowName,
    flowStep: null,
    flowData: initialData,
  });
}

function clearFlow(phoneNumber) {
  const conv = get(phoneNumber);
  if (conv) {
    conv.activeFlow = null;
    conv.flowStep = null;
    conv.flowData = {};
    conv.lastActivity = Date.now();
  }
}

// Periodic cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, conv] of conversations) {
    if (now - conv.lastActivity > TTL) {
      conversations.delete(key);
    }
  }
}, 5 * 60 * 1000);

module.exports = { get, set, update, clear, startFlow, clearFlow };
