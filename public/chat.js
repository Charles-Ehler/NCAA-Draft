// ─── Chat config ──────────────────────────────────────────
const CHAT_URL = 'https://api.jsonbin.io/v3/b/69bb168baa77b81da9f8b191';
const CHAT_KEY = '$2a$10$Qjr41H9zdqcfVa2gj3iPWu/5.U4lhj7v6nqdIJXZC4/mZfBHIRkUW';

// ─── State ────────────────────────────────────────────────
let chatOpen      = false;
let chatMessages  = [];
let chatSeenCount = 0;
let chatSending   = false;

// ─── Name helpers ─────────────────────────────────────────
function getChatName() {
  return localStorage.getItem('chat-name') || '';
}

function setChatName() {
  const val = document.getElementById('chat-name-input').value.trim();
  if (!val) return;
  localStorage.setItem('chat-name', val);
  document.getElementById('chat-name-setup').style.display = 'none';
  document.getElementById('chat-compose').style.display    = 'flex';
  document.getElementById('chat-input').focus();
}

// ─── Toggle panel ─────────────────────────────────────────
function toggleChat() {
  chatOpen = !chatOpen;
  const panel = document.getElementById('chat-panel');

  if (chatOpen) {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    chatSeenCount = chatMessages.length;
    updateChatBadge();
    renderChatMessages();

    // Focus the right input — display state is already correct from init or setChatName()
    if (getChatName()) {
      setTimeout(() => document.getElementById('chat-input').focus(), 80);
    } else {
      setTimeout(() => document.getElementById('chat-name-input').focus(), 80);
    }
  } else {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    panel.style.height = '';  // reset iOS viewport override
  }
}

// ─── Badge ────────────────────────────────────────────────
function updateChatBadge() {
  const badge  = document.getElementById('chat-badge');
  const unread = Math.max(0, chatMessages.length - chatSeenCount);
  if (unread > 0 && !chatOpen) {
    badge.textContent  = unread > 99 ? '99+' : String(unread);
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

// ─── Render ───────────────────────────────────────────────
function renderChatMessages() {
  const list = document.getElementById('chat-messages');
  if (!list) return;

  if (chatMessages.length === 0) {
    list.innerHTML = '<div class="chat-empty">No messages yet.<br>Be the first to talk shit. 💀</div>';
    return;
  }

  const myName = getChatName();
  list.innerHTML = chatMessages.map(m => {
    const isMe = m.name === myName;
    return `
      <div class="chat-msg ${isMe ? 'chat-msg-me' : ''}">
        ${!isMe ? `<div class="chat-msg-author">${chatEsc(m.name)}</div>` : ''}
        <div class="chat-msg-bubble">${chatEsc(m.text)}</div>
        <div class="chat-msg-time">${chatFormatTime(m.ts)}</div>
      </div>
    `;
  }).join('');

  // Scroll to bottom
  list.scrollTop = list.scrollHeight;
}

function chatEsc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function chatFormatTime(ts) {
  const d = new Date(ts);
  if (!ts || isNaN(d.getTime())) return '';
  const now     = new Date();
  const diffMin = Math.round((now - d) / 60000);
  if (diffMin < 1)    return 'just now';
  if (diffMin < 60)   return `${diffMin}m ago`;
  if (diffMin < 1440) return `${Math.round(diffMin / 60)}h ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ─── API ──────────────────────────────────────────────────
async function chatFetch() {
  const res = await fetch(`${CHAT_URL}/latest`, {
    headers: { 'X-Master-Key': CHAT_KEY }
  });
  if (!res.ok) throw new Error(`Chat fetch failed: ${res.status}`);
  const json = await res.json();
  return json.record?.messages ?? [];
}

async function chatSave(messages) {
  const res = await fetch(CHAT_URL, {
    method:  'PUT',
    headers: { 'X-Master-Key': CHAT_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ messages })
  });
  if (!res.ok) throw new Error(`Chat save failed: ${res.status}`);
}

// ─── Poll ─────────────────────────────────────────────────
async function chatPoll() {
  try {
    const messages = await chatFetch();
    const hadNew   = messages.length > chatMessages.length;
    chatMessages   = messages;

    if (chatOpen) {
      renderChatMessages();
      chatSeenCount = chatMessages.length;
    } else if (hadNew) {
      updateChatBadge();
    }
  } catch (e) {
    console.warn('Chat poll error:', e);
  }
}

// ─── Send ─────────────────────────────────────────────────
async function chatSend() {
  if (chatSending) return;

  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text) return;

  const name = getChatName();
  if (!name) return;

  chatSending = true;
  const btn   = document.getElementById('chat-send-btn');
  btn.disabled = true;
  input.value  = '';

  const msg = {
    id:   Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name,
    text,
    ts:   Date.now()
  };

  // Optimistic update
  chatMessages  = [...chatMessages, msg];
  chatSeenCount = chatMessages.length;
  renderChatMessages();

  try {
    const latest  = await chatFetch();
    // Merge: avoid dupe if poll already picked it up
    const ids     = new Set(latest.map(m => m.id));
    if (!ids.has(msg.id)) latest.push(msg);
    const trimmed = latest.slice(-300);   // keep last 300
    await chatSave(trimmed);
    chatMessages  = trimmed;
    chatSeenCount = trimmed.length;
    renderChatMessages();
  } catch (e) {
    console.warn('Chat send error:', e);
    // Leave optimistic message in place
  } finally {
    chatSending  = false;
    btn.disabled = false;
    input.focus();
  }
}

// ─── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Pre-wire the correct section based on localStorage so the
  // panel is ready the instant it opens — no flicker, no re-prompt.
  if (getChatName()) {
    document.getElementById('chat-name-setup').style.display = 'none';
    document.getElementById('chat-compose').style.display    = 'flex';
  } else {
    document.getElementById('chat-name-setup').style.display = 'flex';
    document.getElementById('chat-compose').style.display    = 'none';
  }

  // Initial fetch
  chatPoll();

  // Poll every 10 seconds
  setInterval(chatPoll, 10_000);

  // Enter to send message
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
  });

  // Enter to submit name
  document.getElementById('chat-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); setChatName(); }
  });

  // iOS keyboard: shrink chat panel to visible viewport so input stays visible
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const panel = document.getElementById('chat-panel');
      if (chatOpen) {
        panel.style.height = window.visualViewport.height + 'px';
      }
    });
  }
});
