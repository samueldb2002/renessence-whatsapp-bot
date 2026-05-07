(function () {
  'use strict';

  const API_URL = 'https://agent.renessence.zenithintelligence.ai';
  const BRAND = '#C43E3E';

  // Session ID (persisted per browser)
  let sessionId = localStorage.getItem('rnss_session');
  if (!sessionId) {
    sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('rnss_session', sessionId);
  }

  let isOpen = false;
  let isLoading = false;

  // ── Styles ───────────────────────────────────────────────────────────────
  const css = `
    #rnss-widget * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    #rnss-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      width: 56px; height: 56px; border-radius: 50%; background: ${BRAND};
      border: none; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.25);
      display: flex; align-items: center; justify-content: center;
      transition: transform .2s, box-shadow .2s;
    }
    #rnss-btn:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(0,0,0,.3); }
    #rnss-btn svg { width: 26px; height: 26px; fill: white; transition: opacity .15s; }
    #rnss-panel {
      position: fixed; bottom: 92px; right: 24px; z-index: 99998;
      width: 360px; height: 540px; background: #fff; border-radius: 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,.18); display: flex; flex-direction: column;
      overflow: hidden; transition: opacity .2s, transform .2s;
    }
    #rnss-panel.rnss-hidden { opacity: 0; pointer-events: none; transform: translateY(12px) scale(.97); }
    #rnss-header {
      background: ${BRAND}; padding: 14px 16px; display: flex; align-items: center; gap: 10px;
    }
    #rnss-header-avatar {
      width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,.25);
      display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0;
    }
    #rnss-header-info { flex: 1; }
    #rnss-header-title { color: #fff; font-weight: 600; font-size: 14px; line-height: 1.2; }
    #rnss-header-sub { color: rgba(255,255,255,.75); font-size: 11px; margin-top: 1px; }
    #rnss-close {
      background: none; border: none; cursor: pointer; color: rgba(255,255,255,.8);
      padding: 4px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
    }
    #rnss-close:hover { background: rgba(255,255,255,.15); }
    #rnss-messages {
      flex: 1; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 10px;
      background: #f7f5f3;
    }
    #rnss-messages::-webkit-scrollbar { width: 4px; }
    #rnss-messages::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
    .rnss-msg { display: flex; flex-direction: column; max-width: 82%; }
    .rnss-msg.rnss-user { align-self: flex-end; align-items: flex-end; }
    .rnss-msg.rnss-bot { align-self: flex-start; align-items: flex-start; }
    .rnss-bubble {
      padding: 9px 13px; border-radius: 14px; font-size: 13.5px; line-height: 1.5;
      white-space: pre-wrap; word-break: break-word;
    }
    .rnss-user .rnss-bubble { background: #1a1a1a; color: #fff; border-bottom-right-radius: 4px; }
    .rnss-bot .rnss-bubble { background: #fff; color: #1a1a1a; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .rnss-buttons { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; width: 100%; }
    .rnss-btn-option {
      background: #fff; border: 1.5px solid ${BRAND}; color: ${BRAND};
      border-radius: 10px; padding: 8px 14px; font-size: 13px; font-weight: 500;
      cursor: pointer; text-align: center; transition: background .15s, color .15s;
    }
    .rnss-btn-option:hover { background: ${BRAND}; color: #fff; }
    .rnss-cta-btn {
      background: ${BRAND}; color: #fff; border: none; border-radius: 10px;
      padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
      margin-top: 8px; text-decoration: none; display: inline-block; text-align: center;
      transition: opacity .15s;
    }
    .rnss-cta-btn:hover { opacity: .88; }
    .rnss-typing {
      display: flex; gap: 4px; padding: 10px 14px; background: #fff;
      border-radius: 14px; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.08);
      align-items: center; width: fit-content;
    }
    .rnss-dot { width: 7px; height: 7px; border-radius: 50%; background: #aaa; animation: rnss-bounce .9s infinite; }
    .rnss-dot:nth-child(2) { animation-delay: .15s; }
    .rnss-dot:nth-child(3) { animation-delay: .3s; }
    @keyframes rnss-bounce { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }
    #rnss-footer {
      padding: 10px 12px; background: #fff; border-top: 1px solid #eee;
      display: flex; align-items: flex-end; gap: 8px;
    }
    #rnss-input {
      flex: 1; border: 1.5px solid #e5e5e5; border-radius: 12px; padding: 9px 13px;
      font-size: 13.5px; resize: none; outline: none; line-height: 1.4;
      max-height: 100px; overflow-y: auto; color: #1a1a1a;
      transition: border-color .15s;
    }
    #rnss-input:focus { border-color: ${BRAND}; }
    #rnss-input::placeholder { color: #aaa; }
    #rnss-send {
      width: 38px; height: 38px; border-radius: 10px; background: ${BRAND};
      border: none; cursor: pointer; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      transition: opacity .15s;
    }
    #rnss-send:disabled { opacity: .4; cursor: default; }
    #rnss-send svg { width: 16px; height: 16px; fill: white; }
    @media (max-width: 420px) {
      #rnss-panel { width: calc(100vw - 24px); right: 12px; bottom: 80px; height: 70vh; }
      #rnss-btn { bottom: 16px; right: 16px; }
    }
  `;

  // ── DOM ───────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.id = 'rnss-widget';
  wrapper.innerHTML = `
    <button id="rnss-btn" aria-label="Open chat">
      <svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>
    </button>
    <div id="rnss-panel" class="rnss-hidden" role="dialog" aria-label="Renessence chat">
      <div id="rnss-header">
        <div id="rnss-header-avatar">🌿</div>
        <div id="rnss-header-info">
          <div id="rnss-header-title">Renessence</div>
          <div id="rnss-header-sub">Wellness Centre Amsterdam</div>
        </div>
        <button id="rnss-close" aria-label="Close chat">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div id="rnss-messages"></div>
      <div id="rnss-footer">
        <textarea id="rnss-input" rows="1" placeholder="Type a message…"></textarea>
        <button id="rnss-send" aria-label="Send" disabled>
          <svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/></svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(wrapper);

  const btn = document.getElementById('rnss-btn');
  const panel = document.getElementById('rnss-panel');
  const messagesEl = document.getElementById('rnss-messages');
  const input = document.getElementById('rnss-input');
  const sendBtn = document.getElementById('rnss-send');
  const closeBtn = document.getElementById('rnss-close');

  // ── Helpers ───────────────────────────────────────────────────────────────
  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'rnss-msg rnss-user';
    el.innerHTML = `<div class="rnss-bubble">${escHtml(text)}</div>`;
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function appendBotMessage(data) {
    removeTyping();
    const el = document.createElement('div');
    el.className = 'rnss-msg rnss-bot';

    let inner = `<div class="rnss-bubble">${escHtml(data.message)}</div>`;

    if (data.ui_type === 'buttons' && data.buttons?.length) {
      const btns = data.buttons.map(b =>
        `<button class="rnss-btn-option" data-id="${escAttr(b.id)}" data-title="${escAttr(b.title)}">${escHtml(b.title)}</button>`
      ).join('');
      inner += `<div class="rnss-buttons">${btns}</div>`;
    }

    if (data.ui_type === 'list' && data.list_sections?.length) {
      const rows = data.list_sections.flatMap(s => s.rows || []);
      const btns = rows.map(r =>
        `<button class="rnss-btn-option" data-id="${escAttr(r.id)}" data-title="${escAttr(r.title)}">${escHtml(r.title)}${r.description ? `<span style="display:block;font-size:11px;opacity:.7;font-weight:400">${escHtml(r.description)}</span>` : ''}</button>`
      ).join('');
      inner += `<div class="rnss-buttons">${btns}</div>`;
    }

    if (data.ui_type === 'cta_button' && data.cta_url) {
      inner += `<a href="${escAttr(data.cta_url)}" target="_blank" class="rnss-cta-btn">${escHtml(data.cta_label || 'Open')}</a>`;
    }

    el.innerHTML = inner;

    // Option button clicks
    el.querySelectorAll('.rnss-btn-option').forEach(b => {
      b.addEventListener('click', () => {
        const title = b.getAttribute('data-title');
        // Disable all buttons in this group
        el.querySelectorAll('.rnss-btn-option').forEach(x => x.disabled = true);
        sendMessage(title);
      });
    });

    messagesEl.appendChild(el);
    scrollBottom();
  }

  function showTyping() {
    if (document.getElementById('rnss-typing')) return;
    const el = document.createElement('div');
    el.className = 'rnss-msg rnss-bot';
    el.id = 'rnss-typing';
    el.innerHTML = `<div class="rnss-typing"><div class="rnss-dot"></div><div class="rnss-dot"></div><div class="rnss-dot"></div></div>`;
    messagesEl.appendChild(el);
    scrollBottom();
  }

  function removeTyping() {
    const el = document.getElementById('rnss-typing');
    if (el) el.remove();
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\n/g,'<br>');
  }

  function escAttr(str) {
    return String(str || '').replace(/"/g,'&quot;');
  }

  // ── Greeting ──────────────────────────────────────────────────────────────
  let greeted = sessionStorage.getItem('rnss_greeted');

  function openPanel() {
    isOpen = true;
    panel.classList.remove('rnss-hidden');
    btn.querySelector('svg').style.opacity = '0.7';
    input.focus();
    if (!greeted) {
      greeted = true;
      sessionStorage.setItem('rnss_greeted', '1');
      sendMessage('Hello');
    }
  }

  function closePanel() {
    isOpen = false;
    panel.classList.add('rnss-hidden');
    btn.querySelector('svg').style.opacity = '1';
  }

  // ── API call ──────────────────────────────────────────────────────────────
  async function sendMessage(text) {
    if (isLoading) return;
    isLoading = true;
    sendBtn.disabled = true;
    showTyping();

    try {
      const res = await fetch(`${API_URL}/webchat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text }),
      });
      const data = await res.json();
      appendBotMessage(data);
    } catch {
      removeTyping();
      appendBotMessage({ message: 'Something went wrong. Please try again.', ui_type: 'text' });
    } finally {
      isLoading = false;
      sendBtn.disabled = !input.value.trim();
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────
  btn.addEventListener('click', () => isOpen ? closePanel() : openPanel());
  closeBtn.addEventListener('click', closePanel);

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim() || isLoading;
    // Auto-resize
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!input.value.trim() || isLoading) return;
      const text = input.value.trim();
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;
      appendUserMessage(text);
      sendMessage(text);
    }
  });

  sendBtn.addEventListener('click', () => {
    if (!input.value.trim() || isLoading) return;
    const text = input.value.trim();
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;
    appendUserMessage(text);
    sendMessage(text);
  });

})();
