// ─── State ────────────────────────────────────────────────
let appData      = { managers: [], players: [], rounds: [] };
let currentTab   = 'draft';
let currentRound = 1;
let addPlayerForManagerId = null;
let statsTargetPlayerId   = null;
let statsTargetRound      = null;
let eliminateTargetId     = null;

const ROUND_FULL = {
  1: 'Round of 64', 2: 'Round of 32', 3: 'Sweet 16',
  4: 'Elite 8',     5: 'Final Four',  6: 'Championship'
};
const ROUND_SHORT = { 1:'R64', 2:'R32', 3:'S16', 4:'E8', 5:'F4', 6:'Champ' };

// ─── Scoring ──────────────────────────────────────────────

function calcRoundScore(stat, multiplier) {
  const base =
    (stat.points    || 0) * 1    +
    (stat.rebounds  || 0) * 1.2  +
    (stat.assists   || 0) * 1.5  +
    (stat.blocks    || 0) * 2    +
    (stat.steals    || 0) * 2    +
    (stat.turnovers || 0) * -1;
  return base * multiplier;
}

function calcPlayerScore(player) {
  const multiplier = player.seed >= 9 ? 2 : 1;
  let total = 0;
  for (const round of appData.rounds) {
    const stat = round.stats.find(s => s.playerId === player.id);
    if (stat) total += calcRoundScore(stat, multiplier);
  }
  return round1(total);
}

function calcManagerScore(managerId) {
  return round1(
    appData.players
      .filter(p => p.managerId === managerId)
      .reduce((sum, p) => sum + calcPlayerScore(p), 0)
  );
}

function round1(n) { return Math.round(n * 10) / 10; }

// ─── API ──────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body:    body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadData(silent = false) {
  try {
    appData = await api('GET', '/data');
    renderAll();
  } catch (e) {
    if (!silent) showToast('Could not load data', true);
  }
}

// ─── Navigation ───────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.querySelectorAll(`[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));
  if (tab === 'stats') renderStats();
}

// ─── Render All ───────────────────────────────────────────

function renderAll() {
  renderDraft();
  renderLeaderboard();
  renderStats();
  renderStatus();
}

// ─── DRAFT TAB ────────────────────────────────────────────

function renderDraft() {
  const grid = document.getElementById('draft-grid');
  grid.innerHTML = appData.managers.map(manager => {
    const players = appData.players.filter(p => p.managerId === manager.id);
    const canAdd  = players.length < 5;
    return `
      <div class="card">
        <div class="card-header">
          <h3>${esc(manager.name)}</h3>
          <span class="text-xs text-muted">${players.length}/5</span>
        </div>
        <div style="padding: 6px 14px 12px;">
          ${players.length === 0
            ? `<div class="empty-state" style="padding:20px 0;"><p>No players yet</p></div>`
            : players.map(p => playerItemHTML(p, true)).join('')
          }
          ${canAdd ? `
            <button class="btn-add-player" onclick="openAddPlayer('${manager.id}')">
              <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" style="margin-right:4px"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"/></svg>
              Add Player
            </button>
          ` : `<div class="text-xs text-muted" style="text-align:center;margin-top:10px;padding:4px 0;">Draft full</div>`}
        </div>
      </div>
    `;
  }).join('');
}

function playerItemHTML(p, showDelete = false) {
  const score    = calcPlayerScore(p);
  const isDouble = p.seed >= 9;
  const scoreStr = (score !== 0) ? `${score}` : '—';
  return `
    <div class="player-item ${p.eliminated ? 'eliminated' : ''}">
      <span class="seed-badge ${isDouble ? 'double' : ''}" title="${isDouble ? '2× points (seed 9-16)' : `Seed ${p.seed}`}">${p.seed}</span>
      <div class="player-info">
        <div class="player-name">${esc(p.name)}</div>
        <div class="player-meta">${esc(p.position)} · ${esc(p.team)}${isDouble ? ' · <b style="color:var(--crimson)">2×</b>' : ''}${p.eliminated ? ` · <span style="color:var(--gray-400)">Out R${p.eliminatedRound || '?'}</span>` : ''}</div>
      </div>
      <div class="player-score">${scoreStr}</div>
      ${showDelete ? `
        <button class="btn-ghost-danger" onclick="removePlayer('${p.id}')" title="Remove from draft">
          <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"/></svg>
        </button>
      ` : ''}
    </div>
  `;
}

// ─── LEADERBOARD TAB ──────────────────────────────────────

function renderLeaderboard() {
  const standings = appData.managers
    .map(m => ({ ...m, score: calcManagerScore(m.id), players: appData.players.filter(p => p.managerId === m.id) }))
    .sort((a, b) => b.score - a.score);

  const prizes = { 1: '1st · $200', 2: '2nd · $50' };

  document.getElementById('leaderboard-content').innerHTML = standings.map((m, i) => {
    const rank = i + 1;
    const rankClass = rank <= 3 ? `rank-${rank}` : 'rank-other';
    const prize = prizes[rank] || '';
    return `
      <div class="card lb-card">
        <div class="lb-card-header" onclick="toggleLbPlayers('lb-players-${m.id}')">
          <div class="rank-badge ${rankClass}">${rank}</div>
          <div style="flex:1; min-width:0;">
            <div class="lb-manager-name">${esc(m.name)}</div>
            ${prize ? `<div class="lb-prize-tag">${prize}</div>` : ''}
          </div>
          <div class="lb-score">${m.score}<span>pts</span></div>
          <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" style="color:var(--gray-400);margin-left:8px;flex-shrink:0;"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/></svg>
        </div>
        <div id="lb-players-${m.id}" class="lb-players" style="display:none; padding:4px 14px 8px;">
          ${m.players.length === 0
            ? `<div class="empty-state" style="padding:16px 0;"><p>No players drafted</p></div>`
            : m.players.map(p => playerItemHTML(p, false)).join('')
          }
        </div>
      </div>
    `;
  }).join('');
}

function toggleLbPlayers(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ─── STATS TAB ────────────────────────────────────────────

function renderStats() {
  // Round tabs
  document.getElementById('round-tabs').innerHTML = [1,2,3,4,5,6].map(r => `
    <button class="round-tab ${r === currentRound ? 'active' : ''}" onclick="selectRound(${r})">${ROUND_FULL[r]}</button>
  `).join('');

  const roundData = appData.rounds.find(r => r.round === currentRound);
  const container = document.getElementById('stats-player-list');

  if (appData.players.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No players drafted yet. Add players in the Draft tab.</p></div>`;
    return;
  }

  const sections = appData.managers.map(m => {
    const players = appData.players.filter(p => p.managerId === m.id);
    if (!players.length) return '';
    return `
      <div class="stats-section-header">${esc(m.name)}</div>
      ${players.map(p => {
        const stat     = roundData?.stats.find(s => s.playerId === p.id);
        const hasStats = !!stat;
        const isDouble = p.seed >= 9;
        const roundPts = hasStats
          ? round1(calcRoundScore(stat, p.seed >= 9 ? 2 : 1))
          : null;
        return `
          <div class="stats-player-item" onclick="openStatsModal('${p.id}', ${currentRound})">
            <span class="seed-badge ${isDouble ? 'double' : ''}">${p.seed}</span>
            <div class="player-info" style="flex:1">
              <div class="player-name">${esc(p.name)}</div>
              <div class="player-meta">${esc(p.position)} · ${esc(p.team)}${isDouble ? ' · <b style="color:var(--crimson)">2×</b>' : ''}</div>
            </div>
            ${hasStats
              ? `<div style="text-align:right;">
                   <div class="stats-entered-badge">Stats entered</div>
                   <div class="stats-round-pts">${roundPts} pts</div>
                 </div>`
              : `<span class="text-xs text-muted" style="padding-left:4px">+ Enter stats</span>`
            }
          </div>
        `;
      }).join('')}
    `;
  }).join('');

  container.innerHTML = `<div class="card" style="overflow:hidden">${sections}</div>`;
}

function selectRound(r) {
  currentRound = r;
  renderStats();
}

// ─── STATUS TAB ───────────────────────────────────────────

function renderStatus() {
  const container = document.getElementById('status-content');

  if (appData.players.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No players drafted yet.</p></div>`;
    return;
  }

  const managerCounts = appData.managers.map(m => {
    const all    = appData.players.filter(p => p.managerId === m.id);
    const active = all.filter(p => !p.eliminated).length;
    return { ...m, total: all.length, active };
  });

  const countCards = `
    <div class="active-count-grid mb-16">
      ${managerCounts.map(m => `
        <div class="active-count-card">
          <div class="active-count-num ${m.active > 0 ? 'active' : 'zero'}">${m.active}</div>
          <div class="active-count-name">${esc(m.name)}</div>
          <div class="active-count-sub">${m.active}/${m.total} in</div>
        </div>
      `).join('')}
    </div>
  `;

  const playerList = `
    <div class="card" style="overflow:hidden;">
      <div class="card-header"><h3>Player Status</h3></div>
      ${appData.managers.map(m => {
        const players = appData.players.filter(p => p.managerId === m.id);
        if (!players.length) return '';
        return `
          <div style="border-bottom:1px solid var(--gray-100)">
            <div class="stats-section-header">${esc(m.name)}</div>
            ${players.map(p => `
              <div class="player-item" style="padding:10px 18px;">
                <span class="seed-badge ${p.seed >= 9 ? 'double' : ''}">${p.seed}</span>
                <div class="player-info">
                  <div class="player-name ${p.eliminated ? 'text-muted' : ''}" style="${p.eliminated ? 'text-decoration:line-through' : ''}">${esc(p.name)}</div>
                  <div class="player-meta">${esc(p.position)} · ${esc(p.team)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:7px;flex-shrink:0;">
                  ${p.eliminated
                    ? `<span class="out-tag">Out R${p.eliminatedRound || '?'}</span>
                       <button class="btn-restore" onclick="restorePlayer('${p.id}')">Restore</button>`
                    : `<span class="text-xs text-green"><span class="active-dot"></span>Active</span>
                       <button class="btn-eliminate" onclick="openEliminateModal('${p.id}')">Eliminate</button>`
                  }
                </div>
              </div>
            `).join('')}
          </div>
        `;
      }).join('')}
    </div>
  `;

  container.innerHTML = countCards + playerList;
}

// ─── ADD PLAYER MODAL ─────────────────────────────────────

function openAddPlayer(managerId) {
  addPlayerForManagerId = managerId;
  const mgr = appData.managers.find(m => m.id === managerId);
  document.getElementById('add-player-title').textContent = `Add Player — ${mgr.name}`;
  document.getElementById('add-player-form').reset();
  document.getElementById('double-warning').style.display = 'none';
  document.getElementById('add-player-modal').classList.add('open');
  setTimeout(() => document.getElementById('p-name').focus(), 60);
}
function closeAddPlayer() {
  document.getElementById('add-player-modal').classList.remove('open');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('p-seed').addEventListener('input', function () {
    const v = parseInt(this.value);
    document.getElementById('double-warning').style.display =
      (v >= 9 && v <= 16) ? 'block' : 'none';
  });
});

async function submitAddPlayer() {
  const name     = document.getElementById('p-name').value.trim();
  const team     = document.getElementById('p-team').value.trim();
  const seedRaw  = document.getElementById('p-seed').value;
  const position = document.getElementById('p-pos').value;

  if (!name || !team || !seedRaw || !position) {
    showToast('Please fill in all fields', true); return;
  }

  try {
    await api('POST', '/players', {
      name, team, seed: parseInt(seedRaw), position,
      managerId: addPlayerForManagerId
    });
    closeAddPlayer();
    await loadData(true);
    showToast(`${name} added to draft`);
  } catch (e) {
    showToast(e.message, true);
  }
}

// ─── STATS MODAL ──────────────────────────────────────────

function openStatsModal(playerId, round) {
  statsTargetPlayerId = playerId;
  statsTargetRound    = round;

  const player    = appData.players.find(p => p.id === playerId);
  const roundData = appData.rounds.find(r => r.round === round);
  const existing  = roundData?.stats.find(s => s.playerId === playerId);

  document.getElementById('stats-modal-title').textContent =
    `${player.name} — ${ROUND_FULL[round]}`;

  const fields = ['pts','reb','ast','blk','stl','to'];
  const keys   = ['points','rebounds','assists','blocks','steals','turnovers'];
  fields.forEach((f, i) => {
    document.getElementById(`s-${f}`).value = existing ? (existing[keys[i]] ?? '') : '';
  });

  // Show/hide "Clear Stats" button
  document.getElementById('clear-stats-btn').style.display = existing ? 'flex' : 'none';

  updateScorePreview();
  document.getElementById('stats-modal').classList.add('open');
  setTimeout(() => document.getElementById('s-pts').focus(), 60);
}
function closeStatsModal() {
  document.getElementById('stats-modal').classList.remove('open');
}

function updateScorePreview() {
  const pts = parseFloat(document.getElementById('s-pts').value) || 0;
  const reb = parseFloat(document.getElementById('s-reb').value) || 0;
  const ast = parseFloat(document.getElementById('s-ast').value) || 0;
  const blk = parseFloat(document.getElementById('s-blk').value) || 0;
  const stl = parseFloat(document.getElementById('s-stl').value) || 0;
  const to  = parseFloat(document.getElementById('s-to').value)  || 0;

  const player     = appData.players.find(p => p.id === statsTargetPlayerId);
  const multiplier = player?.seed >= 9 ? 2 : 1;
  const base       = pts * 1 + reb * 1.2 + ast * 1.5 + blk * 2 + stl * 2 + to * -1;
  const total      = round1(base * multiplier);

  const breakdown = [
    pts  ? `${pts} pts`                         : '',
    reb  ? `${round1(reb * 1.2)} from reb`      : '',
    ast  ? `${round1(ast * 1.5)} from ast`      : '',
    blk  ? `${round1(blk * 2)} from blk`        : '',
    stl  ? `${round1(stl * 2)} from stl`        : '',
    to   ? `−${to} from TO`                     : ''
  ].filter(Boolean).join(' · ') || 'No stats yet';

  document.getElementById('score-preview').innerHTML = `
    <div class="score-preview-label">${multiplier > 1 ? `Seed ${player?.seed} — 2× multiplier applied · ` : ''}Base: ${round1(base)} pts</div>
    <div class="score-preview-total">${total} fantasy pts</div>
    <div class="score-preview-breakdown">${breakdown}</div>
  `;
}

async function submitStats() {
  const stats = {
    points:    parseFloat(document.getElementById('s-pts').value) || 0,
    rebounds:  parseFloat(document.getElementById('s-reb').value) || 0,
    assists:   parseFloat(document.getElementById('s-ast').value) || 0,
    blocks:    parseFloat(document.getElementById('s-blk').value) || 0,
    steals:    parseFloat(document.getElementById('s-stl').value) || 0,
    turnovers: parseFloat(document.getElementById('s-to').value)  || 0
  };

  try {
    await api('POST', '/stats', { round: statsTargetRound, playerId: statsTargetPlayerId, stats });
    closeStatsModal();
    await loadData(true);
    showToast('Stats saved');
  } catch (e) {
    showToast(e.message, true);
  }
}

async function clearStats() {
  try {
    await api('DELETE', `/stats/${statsTargetRound}/${statsTargetPlayerId}`);
    closeStatsModal();
    await loadData(true);
    showToast('Stats cleared');
  } catch (e) {
    showToast(e.message, true);
  }
}

// ─── ELIMINATE MODAL ──────────────────────────────────────

function openEliminateModal(playerId) {
  eliminateTargetId = playerId;
  const p = appData.players.find(pl => pl.id === playerId);
  document.getElementById('eliminate-title').textContent = `Eliminate ${p.name}`;
  document.getElementById('eliminate-round').value = '';
  document.getElementById('eliminate-modal').classList.add('open');
}
function closeEliminateModal() {
  document.getElementById('eliminate-modal').classList.remove('open');
}
async function confirmEliminate() {
  const round = parseInt(document.getElementById('eliminate-round').value);
  if (!round) { showToast('Select the round they were eliminated', true); return; }
  try {
    await api('PUT', `/players/${eliminateTargetId}`, { eliminated: true, eliminatedRound: round });
    closeEliminateModal();
    await loadData(true);
    showToast('Player eliminated');
  } catch (e) {
    showToast(e.message, true);
  }
}
async function restorePlayer(playerId) {
  try {
    await api('PUT', `/players/${playerId}`, { eliminated: false, eliminatedRound: null });
    await loadData(true);
    showToast('Player restored');
  } catch (e) {
    showToast(e.message, true);
  }
}

// ─── REMOVE PLAYER ────────────────────────────────────────

async function removePlayer(playerId) {
  const p = appData.players.find(pl => pl.id === playerId);
  if (!confirm(`Remove ${p?.name || 'this player'} from the draft? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/players/${playerId}`);
    await loadData(true);
    showToast('Player removed');
  } catch (e) {
    showToast(e.message, true);
  }
}

// ─── TOAST ────────────────────────────────────────────────

let toastTimer;
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ─── UTILS ────────────────────────────────────────────────

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ─── INIT ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadData();
  // Refresh every 30s for live scores
  setInterval(() => loadData(true), 30000);

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  // Enter key in add-player form
  document.getElementById('add-player-form').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitAddPlayer(); }
  });
});
