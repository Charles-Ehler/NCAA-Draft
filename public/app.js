// ─── State ────────────────────────────────────────────────
let appData      = { managers: [], players: [], rounds: [], tournamentTeams: [], lastSync: null };
let currentTab   = 'draft';
let currentRound = 1;
let addPlayerForManagerId = null;
let statsTargetPlayerId   = null;
let statsTargetRound      = null;
let eliminateTargetId     = null;

// ESPN roster cache (teamId → [{name, position}])
let rosterCache = {};

const ROUND_FULL  = { 1:'Round of 64', 2:'Round of 32', 3:'Sweet 16', 4:'Elite 8', 5:'Final Four', 6:'Championship' };
const ROUND_SHORT = { 1:'R64', 2:'R32', 3:'S16', 4:'E8', 5:'F4', 6:'Champ' };

// "Out R64", "Out S16", etc. for elimination badges
function elimBadge(round) { return 'Out ' + (ROUND_SHORT[round] || (round ? `R${round}` : '?')); }

// Round keywords for ESPN round detection
const ROUND_KEYWORDS = [
  { rx: /round of 64|first round|1st round|first four/i,               num: 1 },
  { rx: /round of 32|second round|2nd round/i,                         num: 2 },
  { rx: /sweet 16|sweet sixteen|regional semifinal/i,                  num: 3 },
  { rx: /elite 8|elite eight|regional (final|championship)/i,          num: 4 },
  { rx: /final four|national semifinal/i,                              num: 5 },
  { rx: /national championship|championship game/i,                    num: 6 }
];

// ─── Admin / Password ──────────────────────────────────────
let adminUnlocked        = false;
let pendingAdminCallback = null;
const ADMIN_PASS         = '1234';

function requireAdmin(callback) {
  if (adminUnlocked) { callback(); return; }
  pendingAdminCallback = callback;
  document.getElementById('admin-password-input').value = '';
  document.getElementById('password-error').style.display = 'none';
  document.getElementById('password-modal').classList.add('open');
  setTimeout(() => document.getElementById('admin-password-input').focus(), 60);
}

function submitPassword() {
  const val = document.getElementById('admin-password-input').value;
  if (val === ADMIN_PASS) {
    adminUnlocked = true;
    closePasswordModal();
    if (pendingAdminCallback) { pendingAdminCallback(); pendingAdminCallback = null; }
  } else {
    document.getElementById('password-error').style.display = 'block';
    document.getElementById('admin-password-input').value   = '';
    document.getElementById('admin-password-input').focus();
  }
}

function closePasswordModal() {
  document.getElementById('password-modal').classList.remove('open');
  pendingAdminCallback = null;
}

// ─── Scoring ──────────────────────────────────────────────
function calcRoundScore(stat, multiplier) {
  const base =
    (stat.points    || 0) * 1   +
    (stat.rebounds  || 0) * 1.2 +
    (stat.assists   || 0) * 1.5 +
    (stat.blocks    || 0) * 2   +
    (stat.steals    || 0) * 2   +
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

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

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
  const bar = document.getElementById('loading-bar');
  if (bar) { bar.style.width = '40%'; bar.classList.add('active'); }
  try {
    appData = await api('GET', '/data');
    renderAll();
    updateLastSyncDisplay();
    updateTeamsStatus();
    generateCallouts();
    if (bar) { bar.style.width = '100%'; setTimeout(() => { bar.style.width = '0%'; bar.classList.remove('active'); }, 300); }
  } catch (e) {
    if (bar) { bar.style.width = '0%'; bar.classList.remove('active'); }
    if (!silent) showToast('Could not load data', true);
  }
}

// ─── Navigation ───────────────────────────────────────────
function detectCurrentRound() {
  // Find the highest round that has any stats entered
  const rounds = appData.rounds || [];
  const activeRounds = rounds.filter(r => r.stats && r.stats.length > 0);
  if (activeRounds.length > 0) {
    return Math.max(...activeRounds.map(r => r.round));
  }
  return 1;
}

function switchTab(tab) {
  currentTab = tab;
  localStorage.setItem('dig_bicken_active_tab', tab);
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.querySelectorAll(`[data-tab="${tab}"]`).forEach(b => b.classList.add('active'));
  if (tab === 'stats') {
    currentRound = detectCurrentRound();
    renderStats();
  }
  if (tab === 'players') renderPlayers();
}

// ─── Render All ───────────────────────────────────────────
function renderAll() {
  renderDraft();
  renderLeaderboard();
  renderPlayers();
  renderStats();
  renderStatus();
}

// ─── DRAFT TAB ────────────────────────────────────────────
function renderDraft() {
  const grid = document.getElementById('draft-grid');

  // Sort managers by total fantasy points descending
  const sorted = [...appData.managers].sort((a, b) => calcManagerScore(b.id) - calcManagerScore(a.id));
  const maxScore = Math.max(...sorted.map(m => calcManagerScore(m.id)), 0);

  grid.innerHTML = sorted.map((manager, cardIdx) => {
    const players   = appData.players.filter(p => p.managerId === manager.id);
    const canAdd    = players.length < 5;
    const score     = calcManagerScore(manager.id);
    const isLeader  = maxScore > 0 && score === maxScore;
    const slotsLeft = 5 - players.length;

    const emptySlots = Array.from({ length: slotsLeft }, () =>
      `<div class="player-slot-empty">Empty slot</div>`
    ).join('');

    return `
      <div class="card draft-card ${isLeader ? 'is-leader' : ''}" style="--i:${cardIdx}">
        <div class="card-header">
          <h3>${esc(manager.name)}<span class="leader-crown">👑</span></h3>
          <span class="draft-mgr-score">${players.length}/5 · ${score > 0 ? score + ' pts' : '0 pts'}</span>
        </div>
        <div style="padding: 6px 14px 12px;">
          ${players.map((p, i) => playerItemHTML(p, true, i)).join('')}
          ${emptySlots}
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

function playerItemHTML(p, showDelete = false, animIndex = -1) {
  const score    = calcPlayerScore(p);
  const isDouble = p.seed >= 9;
  const scoreStr = score !== 0 ? `${score}` : '—';

  // Build stat pills from all rounds
  const statParts = [];
  for (const r of appData.rounds) {
    const s = r.stats.find(st => st.playerId === p.id);
    if (!s) continue;
    if (s.points)    statParts.push(`${s.points}pts`);
    if (s.rebounds)  statParts.push(`${s.rebounds}reb`);
    if (s.assists)   statParts.push(`${s.assists}ast`);
    if (s.blocks)    statParts.push(`${s.blocks}blk`);
    if (s.steals)    statParts.push(`${s.steals}stl`);
  }
  const pillLine = statParts.length ? `<div class="player-stat-pills">${statParts.join(' · ')}</div>` : '';
  const animStyle = animIndex >= 0
    ? `style="animation: cardFadeUp 0.25s ease both; animation-delay: ${animIndex * 40}ms"`
    : '';
  return `
    <div class="player-item ${p.eliminated ? 'eliminated' : ''}"
         ${animStyle}
         onmouseenter="showPlayerTooltip(event,'${p.id}')"
         onmouseleave="hidePlayerTooltip()"
         ontouchstart="showPlayerTooltip(event,'${p.id}')"
         ontouchend="hidePlayerTooltip()">
      <span class="seed-badge ${isDouble ? 'double' : ''}">${p.seed}</span>
      ${isDouble ? '<span class="badge-2x">2×</span>' : ''}
      <div class="player-info">
        <div class="player-name">${esc(p.name)}</div>
        <div class="player-meta">${esc(p.position)} · ${esc(p.team)}${p.eliminated ? ` · <span style="color:var(--gray-400)">${elimBadge(p.eliminatedRound)}</span>` : ''}</div>
        ${pillLine}
      </div>
      <div class="player-score-wrap">
        <div class="player-score">${scoreStr}</div>
        ${showDelete ? `
          <button class="btn-ghost-danger" onclick="event.stopPropagation();removePlayer('${p.id}')" title="Remove from draft">
            <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"/></svg>
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

// ─── LEADERBOARD TAB ──────────────────────────────────────
function renderLeaderboard() {
  const standings = appData.managers
    .map(m => ({ ...m, score: calcManagerScore(m.id), players: appData.players.filter(p => p.managerId === m.id) }))
    .sort((a, b) => b.score - a.score);

  // Trend arrows: compare current rank to stored previous rank
  const prevKey = 'lb_prev_ranks';
  let prevRanks = {};
  try { prevRanks = JSON.parse(sessionStorage.getItem(prevKey) || '{}'); } catch {}
  const curRanks = {};
  standings.forEach((m, i) => { curRanks[m.id] = i + 1; });
  // Store current for next comparison (with slight delay so arrows are meaningful across refreshes)
  setTimeout(() => { try { sessionStorage.setItem(prevKey, JSON.stringify(curRanks)); } catch {} }, 3000);

  const maxScore = standings[0]?.score || 0;
  const prizes   = { 1: '🥇 $200', 2: '🥈 $50' };

  document.getElementById('leaderboard-content').innerHTML = standings.map((m, i) => {
    const rank      = i + 1;
    const rankClass = rank <= 3 ? `rank-${rank}` : 'rank-other';
    const prize     = prizes[rank] || '';
    const pct       = maxScore > 0 ? Math.round((m.score / maxScore) * 100) : 0;
    const prev      = prevRanks[m.id];
    const trendArrow = prev == null ? '' : prev > rank ? '<span class="lb-trend up">↑</span>' : prev < rank ? '<span class="lb-trend down">↓</span>' : '<span class="lb-trend same">—</span>';

    const playerRows = m.players.length === 0
      ? `<div class="empty-state" style="padding:16px 0;"><p>No players drafted</p></div>`
      : m.players.map(p => {
          const pScore   = calcPlayerScore(p);
          const isDouble = p.seed >= 9;
          const barPct   = m.score > 0 ? Math.min(100, (pScore / m.score) * 100) : 0;
          const ptsClass = pScore === 0 ? 'zero' : '';
          return `
            <div class="lb-player-row"
                 onmouseenter="showPlayerTooltip(event,'${p.id}')"
                 onmouseleave="hidePlayerTooltip()"
                 ontouchstart="showPlayerTooltip(event,'${p.id}')"
                 ontouchend="hidePlayerTooltip()">
              <span class="seed-badge ${isDouble ? 'double' : ''}" style="width:24px;height:24px;font-size:0.68rem;">${p.seed}</span>
              ${isDouble ? '<span class="badge-2x">2×</span>' : ''}
              <div style="flex:1;min-width:0;">
                <div class="lb-player-name ${p.eliminated ? 'is-out' : ''}">
                  ${esc(p.name)}${p.eliminated ? ` <span class="lb-out-badge">${elimBadge(p.eliminatedRound)}</span>` : ''}
                </div>
                <div class="lb-player-sub">${esc(p.position)} · ${esc(p.team)}</div>
                <div class="lb-contrib-track"><div class="lb-contrib-fill" style="width:${barPct.toFixed(1)}%"></div></div>
              </div>
              <div class="lb-player-pts ${ptsClass}">${pScore !== 0 ? pScore : '—'}</div>
            </div>
          `;
        }).join('');

    return `
      <div class="card lb-card">
        <div class="lb-card-header" onclick="toggleLbPlayers('lb-players-${m.id}')">
          <div class="rank-badge ${rankClass}">${rank}</div>
          <div class="lb-manager-info">
            <div class="lb-manager-name">${esc(m.name)}${trendArrow}</div>
            ${prize ? `<div class="lb-prize-tag">${prize}</div>` : ''}
            <div class="lb-progress-track">
              <div class="lb-progress-bar" style="width:${pct}%"></div>
            </div>
          </div>
          <div class="lb-score">${m.score}<span>pts</span></div>
          <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16" style="color:var(--gray-400);margin-left:8px;flex-shrink:0;"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/></svg>
        </div>
        <div id="lb-players-${m.id}" class="lb-players" style="display:none;">
          ${playerRows}
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
  document.getElementById('round-tabs').innerHTML = [1,2,3,4,5,6].map(r => `
    <button class="round-tab ${r === currentRound ? 'active' : ''}" onclick="selectRound(${r})">${ROUND_FULL[r]}</button>
  `).join('');
  // Scroll active tab into view after render
  requestAnimationFrame(() => {
    const active = document.querySelector('.round-tab.active');
    if (active) active.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
  });

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
        const stat      = roundData?.stats.find(s => s.playerId === p.id);
        const hasStats  = !!stat;
        const isDouble  = p.seed >= 9;
        const roundPts  = hasStats ? round1(calcRoundScore(stat, isDouble ? 2 : 1)) : null;
        const totalPts  = calcPlayerScore(p);
        return `
          <div class="stats-player-item ${hasStats ? 'has-stats' : ''}" onclick="openPlayerStatsView('${p.id}')">
            <span class="seed-badge ${isDouble ? 'double' : ''}">${p.seed}</span>
            ${isDouble ? '<span class="badge-2x">2×</span>' : ''}
            <div class="stats-player-name-wrap">
              <div class="stats-player-name">${esc(p.name)}</div>
              <div class="stats-player-sub">${esc(p.position)} · ${esc(p.team)}</div>
            </div>
            ${hasStats
              ? `<div class="stats-pts-col">
                   <div class="stats-round-pts">${roundPts} pts</div>
                   <div class="stats-total-pts">${totalPts} total</div>
                 </div>`
              : `<div class="stats-pts-col">
                   <span class="text-xs text-muted">+ Enter stats</span>
                   ${totalPts !== 0 ? `<div class="stats-total-pts">${totalPts} total</div>` : ''}
                 </div>`
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
  // Scroll selected tab into view
  const active = document.querySelector('.round-tab.active');
  if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
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
            ${players.map(p => {
              const isDouble = p.seed >= 9;
              return `
                <div class="status-player-row ${p.eliminated ? 'is-eliminated' : ''}"
                     onmouseenter="showPlayerTooltip(event,'${p.id}')"
                     onmouseleave="hidePlayerTooltip()">
                  <span class="seed-badge ${isDouble ? 'double' : ''}">${p.seed}</span>
                  ${isDouble ? '<span class="badge-2x">2×</span>' : ''}
                  <div class="status-player-info">
                    <div class="status-player-name ${p.eliminated ? 'crossed' : ''}">${esc(p.name)}</div>
                    <div class="status-player-meta">${esc(p.position)} · ${esc(p.team)}</div>
                  </div>
                  <div class="status-actions">
                    <button class="btn-edit-stats" onclick="requireAdmin(() => _openStatsModal('${p.id}', currentRound))">Stats</button>
                    ${p.eliminated
                      ? `<span class="out-tag">${elimBadge(p.eliminatedRound)}</span>
                         <button class="btn-restore" onclick="restorePlayer('${p.id}')">Restore</button>`
                      : `<span class="text-xs text-green" style="white-space:nowrap"><span class="active-dot"></span>Active</span>
                         <button class="btn-eliminate" onclick="openEliminateModal('${p.id}')">Eliminate</button>`
                    }
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }).join('')}
    </div>
  `;

  container.innerHTML = countCards + playerList;
}

// ─── PLAYERS TAB ──────────────────────────────────────────
function renderPlayers() {
  const container = document.getElementById('players-content');
  if (!container) return;

  if (appData.players.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No players drafted yet.</p></div>`;
    return;
  }

  // Score every player
  const scored = appData.players.map(p => {
    const multiplier = p.seed >= 9 ? 2 : 1;
    const rounds = appData.rounds.map(r => {
      const stat = r.stats.find(s => s.playerId === p.id);
      if (!stat) return null;
      const base  = round1(calcRoundScore(stat, 1));
      const total = round1(calcRoundScore(stat, multiplier));
      return { round: r.round, name: r.name, stat, base, total };
    }).filter(Boolean);
    const totalPts = round1(rounds.reduce((s, r) => s + r.total, 0));
    const mgr = appData.managers.find(m => m.id === p.managerId);
    return { ...p, multiplier, rounds, totalPts, mgrName: mgr?.name || '?' };
  });

  // Sort: purely by total fantasy points descending
  scored.sort((a, b) => b.totalPts - a.totalPts);

  const ROUND_FULL_MAP = { 1:'Round of 64',2:'Round of 32',3:'Sweet 16',4:'Elite 8',5:'Final Four',6:'Championship' };

  const cards = scored.map((p, idx) => {
    const rank       = idx + 1;
    const isDouble   = p.multiplier === 2;
    const rankLabel  = ordinal(rank);
    const rankMedal  = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';

    const roundRows = p.rounds.map(r => {
      const s = r.stat;
      const statLine = [
        s.points    ? `${s.points} PTS`  : '',
        s.rebounds  ? `${s.rebounds} REB` : '',
        s.assists   ? `${s.assists} AST`  : '',
        s.blocks    ? `${s.blocks} BLK`   : '',
        s.steals    ? `${s.steals} STL`   : '',
        s.turnovers ? `${s.turnovers} TO` : ''
      ].filter(Boolean).join(' · ') || '—';

      return `
        <div class="pl-round-row">
          <span class="pl-round-name">${ROUND_FULL_MAP[r.round] || r.name}</span>
          <span class="pl-round-stats">${statLine}</span>
          <span class="pl-round-pts">${isDouble ? `<span class="pl-2x-note">2×</span> ` : ''}+${r.total} pts</span>
        </div>
      `;
    }).join('');

    return `
      <div class="pl-card ${p.eliminated ? 'pl-eliminated' : ''} ${rank <= 3 ? 'pl-rank-' + rank : ''}" onclick="togglePlayerCard(this)">
        <div class="pl-card-main">
          <div class="pl-rank">${rankMedal || rankLabel}</div>
          <div class="pl-info">
            <div class="pl-name">${esc(p.name)}
              ${isDouble ? '<span class="badge-2x">2×</span>' : ''}
              ${p.eliminated ? `<span class="pl-out-badge">${elimBadge(p.eliminatedRound)}</span>` : ''}
            </div>
            <div class="pl-meta">
              <span class="seed-badge ${isDouble ? 'double' : ''}">${p.seed}</span>
              ${esc(p.team)} · ${esc(p.position)} · <span class="pl-mgr">${esc(p.mgrName)}'s pick</span>
            </div>
          </div>
          <div class="pl-pts">${p.totalPts}<span class="pl-pts-label">pts</span></div>
        </div>
        ${p.rounds.length ? `<div class="pl-breakdown">${roundRows}</div>` : ''}
      </div>
    `;
  }).join('');

  container.innerHTML = `<div class="pl-list">${cards}</div>`;
}

function togglePlayerCard(card) {
  card.classList.toggle('pl-expanded');
}

// ─── ADD PLAYER MODAL ─────────────────────────────────────

// Public entry point — gated by admin
function openAddPlayer(managerId) {
  requireAdmin(() => _openAddPlayer(managerId));
}

function _openAddPlayer(managerId) {
  addPlayerForManagerId = managerId;
  const mgr = appData.managers.find(m => m.id === managerId);
  document.getElementById('add-player-title').textContent = `Add Player — ${mgr.name}`;
  document.getElementById('add-player-form').reset();
  document.getElementById('double-warning').style.display   = 'none';

  // ESPN section
  const teams      = appData.tournamentTeams || [];
  const espnSection = document.getElementById('espn-player-section');
  const manualLabel = document.getElementById('manual-fields-label');

  if (teams.length > 0) {
    espnSection.style.display = 'block';
    manualLabel.style.display = 'block';

    const teamSel = document.getElementById('p-espn-team');
    teamSel.innerHTML = '<option value="">Choose a team…</option>' +
      teams.map(t => `<option value="${esc(t.id)}">Seed ${t.seed} — ${esc(t.name)}</option>`).join('');

    document.getElementById('espn-player-select-wrap').style.display = 'none';
    document.getElementById('espn-roster-loading').style.display     = 'none';
  } else {
    espnSection.style.display = 'none';
    manualLabel.style.display = 'none';
  }

  document.getElementById('add-player-modal').classList.add('open');
  const firstFocus = teams.length > 0
    ? document.getElementById('p-espn-team')
    : document.getElementById('p-name');
  setTimeout(() => firstFocus.focus(), 60);
}

function closeAddPlayer() {
  document.getElementById('add-player-modal').classList.remove('open');
}

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

// ─── ESPN: Load Tournament Teams ───────────────────────────

function loadTournamentTeams() {
  requireAdmin(async () => {
    const btn = document.getElementById('load-teams-btn');
    btn.disabled    = true;
    btn.textContent = 'Loading…';
    document.getElementById('teams-status').textContent = '';

    try {
      showToast('Fetching tournament bracket from ESPN…');
      const raw = await fetch('/api/espn/bracket').then(r => r.json());
      if (raw.error) throw new Error(raw.error);

      const teams = parseBracketTeams(raw);
      if (teams.length === 0) throw new Error('No tournament teams found in ESPN response. The bracket may not be published yet.');

      // Save to server so it persists
      await api('PUT', '/meta', { tournamentTeams: teams });
      appData.tournamentTeams = teams;

      updateTeamsStatus();
      showToast(`Loaded ${teams.length} tournament teams`);
      renderDraft(); // refresh Add Player buttons
    } catch (e) {
      showToast('ESPN bracket: ' + e.message, true);
      document.getElementById('teams-status').textContent = 'Load failed — manual entry still works';
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Load Tournament Teams';
    }
  });
}

// Flexible recursive bracket parser — handles any ESPN API structure
function parseBracketTeams(data) {
  const teams = new Map();

  function traverse(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(traverse); return; }

    // Match: object with team.id + team.displayName + seed
    if (obj.team?.id && (obj.team.displayName || obj.team.name) && obj.seed !== undefined) {
      const id = String(obj.team.id);
      if (!teams.has(id)) {
        teams.set(id, {
          id,
          name:      obj.team.displayName || obj.team.name,
          shortName: obj.team.abbreviation || obj.team.shortDisplayName || obj.team.displayName || obj.team.name,
          seed:      parseInt(obj.seed) || 0
        });
      }
    }

    // Also match: competitor-style objects { id, seed, team: { id, displayName } }
    if (obj.id && obj.seed && obj.team?.id && (obj.team.displayName || obj.team.name)) {
      const id = String(obj.team.id);
      if (!teams.has(id)) {
        teams.set(id, {
          id,
          name:      obj.team.displayName || obj.team.name,
          shortName: obj.team.abbreviation || obj.team.shortDisplayName || obj.team.name,
          seed:      parseInt(obj.seed) || 0
        });
      }
    }

    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') traverse(val);
    }
  }

  traverse(data);

  return [...teams.values()]
    .filter(t => t.seed >= 1 && t.seed <= 16)
    .sort((a, b) => a.seed - b.seed || a.name.localeCompare(b.name));
}

function updateTeamsStatus() {
  const teams  = appData.tournamentTeams || [];
  const el     = document.getElementById('teams-status');
  if (!el) return;
  el.textContent = teams.length > 0 ? `${teams.length} teams loaded` : '';
}

// ─── ESPN: Load Team Roster ────────────────────────────────

async function loadTeamRoster(teamId) {
  document.getElementById('espn-player-select-wrap').style.display = 'none';
  document.getElementById('espn-roster-loading').style.display     = 'none';

  if (!teamId) return;

  // Auto-fill team name + seed from loaded teams
  const team = (appData.tournamentTeams || []).find(t => t.id === teamId);
  if (team) {
    document.getElementById('p-team').value = team.name;
    document.getElementById('p-seed').value = team.seed;
    document.getElementById('double-warning').style.display = team.seed >= 9 ? 'block' : 'none';
  }

  // Use cache if available
  if (rosterCache[teamId]) {
    populatePlayerSelect(rosterCache[teamId]);
    return;
  }

  document.getElementById('espn-roster-loading').style.display = 'block';

  try {
    const raw = await fetch(`/api/espn/roster/${teamId}`).then(r => r.json());
    if (raw.error) throw new Error(raw.error);

    const players        = parseRoster(raw);
    rosterCache[teamId]  = players;
    populatePlayerSelect(players);
  } catch (e) {
    document.getElementById('espn-roster-loading').style.display = 'none';
    showToast('Could not load roster: ' + e.message, true);
  }
}

function parseRoster(data) {
  // ESPN roster response: { athletes: [...] }
  const athletes = data.athletes || data.roster?.athletes || [];
  return athletes
    .filter(a => a.displayName || a.fullName || a.name)
    .map(a => ({
      name:     a.displayName || `${a.firstName || ''} ${a.lastName || ''}`.trim() || a.name,
      position: a.position?.abbreviation || a.position?.name || '?',
      jersey:   a.jersey || ''
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function populatePlayerSelect(players) {
  document.getElementById('espn-roster-loading').style.display = 'none';

  const sel = document.getElementById('p-espn-player');
  sel.innerHTML = '<option value="">Choose a player…</option>' +
    players.map((p, i) => `<option value="${i}">#${p.jersey ? p.jersey + ' ' : ''}${esc(p.name)} — ${esc(p.position)}</option>`).join('');

  document.getElementById('espn-player-select-wrap').style.display = 'block';
}

function fillPlayerFromEspn(idx) {
  if (idx === '') return;
  const teamId  = document.getElementById('p-espn-team').value;
  const players = rosterCache[teamId];
  if (!players) return;

  const player = players[parseInt(idx)];
  if (!player) return;

  document.getElementById('p-name').value = player.name;

  // Map ESPN position to our select options
  const pos     = player.position.toUpperCase();
  const posMap  = { G: 'G', PG: 'PG', SG: 'SG', F: 'F', SF: 'SF', PF: 'PF', C: 'C' };
  const mapped  = posMap[pos] || (pos.includes('G') ? 'G' : pos.includes('F') ? 'F' : pos.includes('C') ? 'C' : '');
  const posEl   = document.getElementById('p-pos');
  if (mapped && [...posEl.options].some(o => o.value === mapped)) posEl.value = mapped;
}

// ─── ESPN: Sync Stats ──────────────────────────────────────

function syncStats() {
  _doSync();
}

// Silent background sync — runs for everyone, no admin required
async function autoSyncStats() {
  try { await _doSync(true); } catch (e) { console.warn('Auto-sync failed:', e); }
}

async function _doSync(silent = false) {
  const btn = document.getElementById('sync-stats-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  setSyncingState(true);

  try {
    if (!silent) showToast('Syncing stats from ESPN…');

    // Build list of dates to check: today + last 4 days (captures games that finished yesterday etc.)
    const dates = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    }

    const seenIds = new Set();
    const events  = [];
    for (const date of dates) {
      const sb = await fetch(`/api/espn/scoreboard?dates=${date}`).then(r => r.json());
      if (sb.error) continue;
      for (const e of sb.events || []) {
        if (!seenIds.has(e.id) && e.status?.type?.completed && isTournamentEvent(e)) {
          seenIds.add(e.id);
          events.push(e);
        }
      }
    }

    if (events.length === 0) {
      if (!silent) showToast('No completed tournament games found');
      return;
    }

    let totalSynced = 0;

    for (const event of events) {
      const round = extractRound(event);
      if (!round) continue;

      try {
        const summary = await fetch(`/api/espn/summary/${event.id}`).then(r => r.json());
        if (summary.error) continue;
        totalSynced += await applyGameStats(summary, round);
      } catch (err) {
        console.warn(`Failed to sync game ${event.id}:`, err);
      }
    }

    const now = new Date().toISOString();
    await api('PUT', '/meta', { lastSync: now });
    appData.lastSync = now;

    // Trigger server-side elimination check after stat sync
    fetch('/api/check-eliminations').catch(() => {});

    await loadData(true);
    updateLastSyncDisplay();

    if (!silent) showToast(`Synced stats for ${totalSynced} player(s)`);
    else if (totalSynced > 0) showToast('Stats updated');

  } catch (e) {
    if (!silent) showToast('Sync failed: ' + e.message, true);
    else console.warn('Background sync failed:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sync Stats'; }
    setSyncingState(false);
  }
}

// Parse box score from ESPN game summary and save matched stats
async function applyGameStats(summary, round) {
  // ESPN summary.boxscore.players: array of team box scores
  // Each has .team and .statistics[].{ keys, athletes[].{ athlete, stats[] } }
  const boxPlayers = [];

  for (const teamBox of summary.boxscore?.players || []) {
    for (const statGroup of teamBox.statistics || []) {
      const labels = statGroup.labels || [];
      for (const entry of statGroup.athletes || []) {
        const stats = entry.stats || [];
        const row   = { name: entry.athlete?.displayName || '', parsed: {} };

        // Map stat labels (PTS, REB, etc.) to values
        labels.forEach((label, i) => {
          const val = parseFloat(stats[i]);
          row.parsed[label.toUpperCase()] = isNaN(val) ? 0 : val;
        });

        boxPlayers.push(row);
      }
    }
  }

  let count = 0;
  for (const player of appData.players) {
    const match = boxPlayers.find(bp => namesMatch(bp.name, player.name));
    if (!match) continue;

    const p = match.parsed;
    const stats = {
      points:    p['PTS']  || 0,
      rebounds:  p['REB']  || p['DREB'] + (p['OREB'] || 0) || 0,
      assists:   p['AST']  || 0,
      blocks:    p['BLK']  || 0,
      steals:    p['STL']  || 0,
      turnovers: p['TO']   || p['TOV'] || 0
    };

    // Skip if player clearly didn't play (all zeros — DNP)
    if (Object.values(stats).every(v => v === 0)) continue;

    try {
      await api('POST', '/stats', { round, playerId: player.id, stats });
      count++;
    } catch (err) {
      console.warn(`Failed to save stats for ${player.name}:`, err);
    }
  }

  return count;
}

// Fuzzy name matching (case-insensitive, handles abbreviated first names)
function namesMatch(espnName, draftName) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  const a = norm(espnName);
  const b = norm(draftName);
  if (!a || !b) return false;
  if (a === b)  return true;

  // Check last name match + first initial or partial first
  const [aFirst, ...aRest] = a.split(' ');
  const [bFirst, ...bRest] = b.split(' ');
  const aLast = aRest.join(' ');
  const bLast = bRest.join(' ');

  if (aLast && bLast && aLast === bLast) {
    // Last names match — check first name initial or prefix
    return aFirst[0] === bFirst[0];
  }

  return a.includes(b) || b.includes(a);
}

function isTournamentEvent(event) {
  // NCAA Tournament is season type 3 in ESPN's system
  if (event.season?.type === 3 || event.season?.type === '3') return true;

  // Check event notes or name for tournament keywords
  const notes = event.competitions?.[0]?.notes || [];
  const note  = notes.map(n => n.headline || '').join(' ').toLowerCase();
  const name  = (event.name || event.shortName || '').toLowerCase();
  return /ncaa|tournament|march madness/.test(note) || /ncaa|tournament/.test(name);
}

function extractRound(event) {
  const notes = (event.competitions?.[0]?.notes || []).map(n => n.headline || '').join(' ');
  const name  = event.name || event.shortName || '';
  const text  = notes + ' ' + name;

  for (const { rx, num } of ROUND_KEYWORDS) {
    if (rx.test(text)) return num;
  }

  // Fallback: try season note
  const seasonNote = event.season?.displayName || '';
  for (const { rx, num } of ROUND_KEYWORDS) {
    if (rx.test(seasonNote)) return num;
  }

  return null;
}

// ─── Last Sync Display ─────────────────────────────────────
function setSyncingState(syncing) {
  const el = document.getElementById('last-sync-display');
  if (!el) return;
  if (syncing) {
    el.innerHTML = '<span class="sync-indicator">⟳ Syncing…</span>';
  } else {
    updateLastSyncDisplay();
  }
}

function updateLastSyncDisplay() {
  const el = document.getElementById('last-sync-display');
  if (!el) return;
  const ts = appData.lastSync;
  if (!ts) { el.textContent = 'Never synced'; return; }

  const d   = new Date(ts);
  if (isNaN(d.getTime())) { el.textContent = 'Never synced'; return; }

  const now     = new Date();
  const diffMin = Math.round((now - d) / 60000);

  if (diffMin < 1)        el.textContent = 'Updated just now';
  else if (diffMin < 60)  el.textContent = `Updated ${diffMin}m ago`;
  else                    el.textContent = `Updated ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ─── STATS MODAL ──────────────────────────────────────────

// Public entry point — gated by admin
// ─── READ-ONLY PLAYER STATS VIEW (dark sports card) ──────

const ROUND_LONG = {
  1: 'ROUND OF 64', 2: 'ROUND OF 32', 3: 'SWEET 16',
  4: 'ELITE 8',     5: 'FINAL FOUR',  6: 'CHAMPIONSHIP'
};

function openPlayerStatsView(playerId) {
  const p = appData.players.find(pl => pl.id === playerId);
  if (!p) return;
  const manager  = appData.managers.find(m => m.id === p.managerId);
  const isDouble = p.seed >= 9;
  const totalPts = calcPlayerScore(p);
  const mgrTotal = manager ? calcManagerScore(manager.id) : 0;
  const contribPct = mgrTotal > 0 ? Math.min(100, (totalPts / mgrTotal) * 100) : 0;

  // Aggregate totals across all rounds
  const statKeys = ['points','rebounds','assists','blocks','steals','turnovers'];
  const totals   = { points: 0, rebounds: 0, assists: 0, blocks: 0, steals: 0, turnovers: 0 };
  for (const rd of appData.rounds) {
    const stat = rd.stats.find(s => s.playerId === playerId);
    if (stat) for (const k of statKeys) totals[k] += stat[k] || 0;
  }
  const baseScore = round1(calcRoundScore(totals, 1));

  // Stat grid HTML
  const statLabels = ['PTS','REB','AST','BLK','STL','TO'];
  const statGrid = statKeys.map((k, i) => `
    <div class="psv-stat-box">
      <div class="psv-stat-val${k === 'turnovers' ? ' psv-stat-to' : ''}" data-target="${totals[k]}">0</div>
      <div class="psv-stat-label">${statLabels[i]}</div>
    </div>
  `).join('');

  // Round breakdown HTML
  const roundCards = [1,2,3,4,5,6].map((r, i) => {
    const rd   = appData.rounds.find(ro => ro.round === r);
    const stat = rd?.stats.find(s => s.playerId === playerId);
    if (!stat) return null;
    const roundPts = round1(calcRoundScore(stat, isDouble ? 2 : 1));
    const parts = [];
    if (stat.points)    parts.push(`${stat.points}pts`);
    if (stat.rebounds)  parts.push(`${stat.rebounds}reb`);
    if (stat.assists)   parts.push(`${stat.assists}ast`);
    if (stat.blocks)    parts.push(`${stat.blocks}blk`);
    if (stat.steals)    parts.push(`${stat.steals}stl`);
    if (stat.turnovers) parts.push(`${stat.turnovers}to`);
    return `
      <div class="psv-round-card" style="animation-delay:${i * 60}ms">
        <div class="psv-rc-name">${ROUND_LONG[r]}</div>
        <div class="psv-rc-summary">${parts.join(' · ') || '—'}</div>
        <div class="psv-rc-pts">${roundPts}${isDouble ? '<span class="psv-2x-badge">2×</span>' : ''}</div>
      </div>
    `;
  }).filter(Boolean);

  const roundsHtml = roundCards.length > 0
    ? roundCards.join('')
    : '<div class="psv-no-stats">NO STATS RECORDED YET</div>';

  document.getElementById('psv-content').innerHTML = `
    <div class="psv-modal-header">
      ${p.eliminated ? '<div class="psv-elim-stamp">ELIMINATED</div>' : ''}
      <div class="psv-seed-circle ${isDouble ? 'psv-seed-double' : 'psv-seed-normal'}">
        ${p.seed}${isDouble ? '<span class="psv-seed-2x">2×</span>' : ''}
      </div>
      <div class="psv-player-name">${esc(p.name)}</div>
      <div class="psv-player-meta">${esc(p.team)} · ${esc(p.position)}</div>
      <div class="psv-drafted-pill">Drafted by ${esc(manager?.name || '—')}</div>
    </div>
    <div class="psv-body">
      ${isDouble ? `<div class="psv-double-banner">⚡ SEED ${p.seed} — ALL STATS COUNT 2×</div>` : ''}
      <div class="psv-stat-grid">${statGrid}</div>
      <div class="psv-hero-bar">
        <div class="psv-hero-label">TOTAL FANTASY PTS</div>
        <div class="psv-hero-pts" data-target="${totalPts}">0</div>
        ${isDouble ? `<div class="psv-hero-calc">Base: ${baseScore} pts × 2 = ${totalPts} pts</div>` : ''}
      </div>
      <div class="psv-rounds-section">
        <div class="psv-section-label">ROUND BREAKDOWN</div>
        <div class="psv-rounds">${roundsHtml}</div>
      </div>
      <div class="psv-contrib-section">
        <div class="psv-contrib-label">${esc(manager?.name || '—')}'s roster: ${Math.round(contribPct)}% from ${esc(p.name)}</div>
        <div class="psv-contrib-track">
          <div class="psv-contrib-fill" data-target="${contribPct.toFixed(1)}" style="width:0%"></div>
        </div>
      </div>
    </div>
    <div class="psv-footer">
      <button class="psv-close-btn" onclick="closePlayerStatsView()">CLOSE</button>
    </div>
  `;

  document.getElementById('player-stats-view').classList.add('open');

  // Animate numbers + progress bar after paint
  requestAnimationFrame(() => {
    document.querySelectorAll('#psv-content .psv-stat-val[data-target]').forEach(el => {
      psvAnimateCount(el, parseFloat(el.dataset.target) || 0, 600);
    });
    const heroEl = document.querySelector('#psv-content .psv-hero-pts[data-target]');
    if (heroEl) psvAnimateCount(heroEl, parseFloat(heroEl.dataset.target) || 0, 700);
    const fill = document.querySelector('#psv-content .psv-contrib-fill[data-target]');
    if (fill) setTimeout(() => { fill.style.width = fill.dataset.target + '%'; }, 50);
  });
}

function psvAnimateCount(el, target, duration) {
  if (target === 0) { el.textContent = '0'; return; }
  const isFloat = target !== Math.floor(target);
  const start = performance.now();
  (function step(now) {
    const t      = Math.min((now - start) / duration, 1);
    const eased  = 1 - Math.pow(1 - t, 3);
    const val    = target * eased;
    el.textContent = isFloat ? round1(val) : Math.round(val);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = isFloat ? target : target;
  })(start);
}

function closePlayerStatsView() {
  document.getElementById('player-stats-view').classList.remove('open');
}

function openStatsModal(playerId, round) {
  requireAdmin(() => _openStatsModal(playerId, round));
}

function _openStatsModal(playerId, round) {
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
    pts ? `${pts} pts`                    : '',
    reb ? `${round1(reb * 1.2)} from reb` : '',
    ast ? `${round1(ast * 1.5)} from ast` : '',
    blk ? `${round1(blk * 2)} from blk`  : '',
    stl ? `${round1(stl * 2)} from stl`  : '',
    to  ? `−${to} from TO`               : ''
  ].filter(Boolean).join(' · ') || 'No stats yet';

  document.getElementById('score-preview').innerHTML = `
    <div class="score-preview-label">${multiplier > 1 ? `Seed ${player?.seed} — 2× multiplier · ` : ''}Base: ${round1(base)} pts</div>
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

// Gated by admin
function openEliminateModal(playerId) {
  requireAdmin(() => _openEliminateModal(playerId));
}

function _openEliminateModal(playerId) {
  eliminateTargetId = playerId;
  const p = appData.players.find(pl => pl.id === playerId);
  document.getElementById('eliminate-title').textContent  = `Eliminate ${p.name}`;
  document.getElementById('eliminate-round').value        = '';
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

// Gated by admin
function restorePlayer(playerId) {
  requireAdmin(async () => {
    try {
      await api('PUT', `/players/${playerId}`, { eliminated: false, eliminatedRound: null });
      await loadData(true);
      showToast('Player restored');
    } catch (e) {
      showToast(e.message, true);
    }
  });
}

// ─── REMOVE PLAYER ────────────────────────────────────────

function removePlayer(playerId) {
  requireAdmin(async () => {
    const p = appData.players.find(pl => pl.id === playerId);
    if (!confirm(`Remove ${p?.name || 'this player'} from the draft? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/players/${playerId}`);
      await loadData(true);
      showToast('Player removed');
    } catch (e) {
      showToast(e.message, true);
    }
  });
}

// ─── PLAYER TOOLTIP ───────────────────────────────────────

let tooltipTimeout;
const tooltipEl = () => document.getElementById('player-tooltip');

function showPlayerTooltip(e, playerId) {
  const player = appData.players.find(p => p.id === playerId);
  if (!player) return;

  const score    = calcPlayerScore(player);
  const isDouble = player.seed >= 9;

  const roundLines = appData.rounds.map(r => {
    const stat = r.stats.find(s => s.playerId === playerId);
    if (!stat) return '';
    const pts = round1(calcRoundScore(stat, isDouble ? 2 : 1));
    return `<div class="ptt-round"><span>${ROUND_SHORT[r.round]}</span><span><b>${pts > 0 ? '+' : ''}${pts} pts</b></span></div>`;
  }).filter(Boolean).join('');

  const tip = tooltipEl();
  tip.innerHTML = `
    <div class="ptt-name">${esc(player.name)}</div>
    <div class="ptt-meta">${esc(player.team)} · Seed ${player.seed} · ${esc(player.position)}</div>
    ${isDouble ? '<div class="ptt-double">⚡ 2× Seed Multiplier</div>' : ''}
    <div class="ptt-score">${score !== 0 ? score + ' fantasy pts' : '0 pts so far'}</div>
    ${roundLines ? `<hr class="ptt-divider"><div class="ptt-rounds">${roundLines}</div>` : ''}
    ${player.eliminated ? `<div class="ptt-elim">❌ Eliminated — ${ROUND_FULL[player.eliminatedRound] || 'Round ?'}</div>` : ''}
    <div class="ptt-hint">${'ontouchstart' in window ? 'Tap elsewhere to dismiss' : 'Hover for details'}</div>
  `;

  // Position near cursor / touch
  const x = e.touches ? e.touches[0].clientX : e.clientX;
  const y = e.touches ? e.touches[0].clientY : e.clientY;

  tip.style.display = 'block';
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = x + 12;
  let top  = y + 12;
  if (left + tw > window.innerWidth  - 10) left = x - tw - 12;
  if (top  + th > window.innerHeight - 10) top  = y - th - 12;
  tip.style.left = Math.max(6, left) + 'px';
  tip.style.top  = Math.max(6, top)  + 'px';

  clearTimeout(tooltipTimeout);
  tip.classList.add('visible');
}

function hidePlayerTooltip() {
  clearTimeout(tooltipTimeout);
  tooltipTimeout = setTimeout(() => {
    const tip = tooltipEl();
    tip.classList.remove('visible');
    setTimeout(() => { tip.style.display = 'none'; }, 160);
  }, 80);
}

// ─── TOAST ────────────────────────────────────────────────
let toastTimer;
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'toast' + (isError ? ' error' : '');
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

// Tournament hours: noon–midnight CT (CDT = UTC-5)
function isTournamentHours() {
  const now    = new Date();
  const ctHour = (now.getUTCHours() - 5 + 24) % 24;
  return ctHour >= 12;
}

// ─── CALLOUT CARD ─────────────────────────────────────────

let callouts           = [];
let calloutIdx         = 0;
let calloutTimer       = null;
let calloutVisible     = false;
let calloutInitialized = false;

function generateCallouts() {
  const { players, rounds, managers } = appData;
  const result = [];
  const push = (type, emoji, text) => result.push({ type, emoji, text });

  // ── Pre-compute per-player stats ──────────────────────────
  const pStats = players.map(p => {
    const mul = p.seed >= 9 ? 2 : 1;
    let pts = 0;
    const raw = { pts: 0, reb: 0, ast: 0, blk: 0, stl: 0, to: 0 };
    const played = [];
    for (const r of rounds) {
      const s = r.stats.find(x => x.playerId === p.id);
      if (!s) continue;
      const sc = round1(calcRoundScore(s, mul));
      pts += sc;
      raw.pts += s.points    || 0;
      raw.reb += s.rebounds  || 0;
      raw.ast += s.assists   || 0;
      raw.blk += s.blocks    || 0;
      raw.stl += s.steals    || 0;
      raw.to  += s.turnovers || 0;
      played.push({ r, s, sc });
    }
    pts = round1(pts);
    const mgr = managers.find(m => m.id === p.managerId);
    return { ...p, mul, pts, raw, played, mgrName: mgr?.name || '?' };
  });

  const mgrScores = managers.map(m => {
    const pList = pStats.filter(p => p.managerId === m.id);
    return { ...m, score: round1(pList.reduce((s, p) => s + p.pts, 0)), pList };
  }).sort((a, b) => b.score - a.score);

  const leader    = mgrScores[0];
  const lastPlace = mgrScores[mgrScores.length - 1];
  const hasStats  = pStats.some(p => p.played.length > 0);
  const withStats = pStats.filter(p => p.played.length > 0);
  const noStats   = pStats.filter(p => p.played.length === 0 && !p.eliminated);
  const activePl  = pStats.filter(p => !p.eliminated);
  const elimPl    = pStats.filter(p => p.eliminated);
  const totalPts  = round1(pStats.reduce((s, p) => s + p.pts, 0));

  const byPts = [...pStats].sort((a, b) => b.pts - a.pts);
  const byAst = [...pStats].sort((a, b) => b.raw.ast - a.raw.ast);
  const byReb = [...pStats].sort((a, b) => b.raw.reb - a.raw.reb);
  const byBlk = [...pStats].sort((a, b) => b.raw.blk - a.raw.blk);
  const byStl = [...pStats].sort((a, b) => b.raw.stl - a.raw.stl);
  const byTO  = [...pStats].sort((a, b) => b.raw.to  - a.raw.to);
  const byPPR = withStats.map(p => ({ ...p, ppr: round1(p.pts / p.played.length) }))
                         .sort((a, b) => b.ppr - a.ppr);

  let bestRound = null, worstRound = null;
  for (const p of pStats) {
    for (const entry of p.played) {
      if (!bestRound  || entry.sc > bestRound.sc)  bestRound  = { p, ...entry };
      if (!worstRound || entry.sc < worstRound.sc) worstRound = { p, ...entry };
    }
  }

  // ── NO STATS YET ──────────────────────────────────────────
  if (!hasStats) {
    push('blue',   '🏀', `${players.length} players drafted across 5 managers. The tournament is about to get expensive.`);
    push('gold',   '👀', `No stats yet. All 5 managers are sweating. Let the madness begin.`);
    push('blue',   '📊', `First games start soon. Time to find out who actually did their homework.`);
    push('crimson','😤', `The trash talk starts now. The receipts come later.`);
  }

  // ── ACHIEVEMENT (gold) ────────────────────────────────────
  if (hasStats) {
    if (leader.score > 0) {
      push('gold', '🏆', `${leader.name} is winning with ${leader.score} pts. ${leader.name} is up $200 if the tournament ended right now.`);
    }

    const topActive = activePl.filter(p => p.pts > 0).sort((a, b) => b.pts - a.pts)[0];
    if (topActive) {
      push('gold', '⭐', `${topActive.name} is the highest scoring active player with ${topActive.pts} pts. ${topActive.mgrName} looks like a genius.`);
    }

    if (bestRound) {
      push('gold', '💥', `${bestRound.p.name} had the best single round with ${bestRound.sc} pts in ${ROUND_FULL[bestRound.r.round] || bestRound.r.name}.`);
    }

    if (byAst[0]?.raw.ast >= 4) {
      const p = byAst[0];
      push('gold', '🎯', `${p.name} has ${p.raw.ast} assists this tournament. At 1.5× that's ${round1(p.raw.ast * 1.5 * p.mul)} pts from dimes alone.`);
    }

    if (byBlk[0]?.raw.blk >= 2) {
      const p = byBlk[0];
      push('gold', '🧱', `${p.name} has ${p.raw.blk} blocks this tournament. ${p.mgrName} is cashing in — that's ${round1(p.raw.blk * 2 * p.mul)} pts just from shot blocking.`);
    }

    if (byStl[0]?.raw.stl >= 2) {
      const p = byStl[0];
      push('gold', '🕵️', `${p.name} has ${p.raw.stl} steals this tournament. At 2× per steal that's ${round1(p.raw.stl * 2 * p.mul)} pts just from being a menace.`);
    }

    if (byReb[0]?.raw.reb >= 5) {
      const p = byReb[0];
      push('gold', '📦', `${p.name} has more rebounds than anyone in this draft with ${p.raw.reb} total. ${p.mgrName} loves a board man.`);
    }

    const dblDbl = pStats.flatMap(p => p.played
      .filter(({ s }) => s.points >= 10 && s.rebounds >= 10)
      .map(({ r }) => ({ p, r }))
    );
    if (dblDbl.length > 0) {
      const dd = dblDbl[0];
      push('gold', '🎊', `${dd.p.name} dropped a double-double in ${ROUND_FULL[dd.r.round] || dd.r.name}. ${dd.p.mgrName} knew what they were doing.`);
    }

    if (byPts[0]?.pts > 0) {
      const p = byPts[0];
      push('gold', '🔑', `Most valuable pick so far: ${p.name} with ${p.pts} pts for ${p.mgrName}. What a selection.`);
    }

    const topDouble = pStats.filter(p => p.mul === 2 && p.pts > 0).sort((a, b) => b.pts - a.pts)[0];
    if (topDouble) {
      push('gold', '✌️', `The 2× multiplier is paying off. ${topDouble.name} (Seed ${topDouble.seed}) has earned ${round1(topDouble.pts / 2)} bonus pts from the double multiplier.`);
    }

    if (byPPR[0]?.ppr > 0) {
      push('gold', '📈', `${byPPR[0].name} is averaging ${byPPR[0].ppr} pts per round played. That pace wins this thing.`);
    }

    const topActiveMgr = [...mgrScores].sort((a, b) =>
      b.pList.filter(p => !p.eliminated).length - a.pList.filter(p => !p.eliminated).length
    )[0];
    if (topActiveMgr.pList.filter(p => !p.eliminated).length >= 4) {
      const n = topActiveMgr.pList.filter(p => !p.eliminated).length;
      push('gold', '💪', `${topActiveMgr.name} has ${n} players still active. More chances. More hope.`);
    }

    for (const m of mgrScores) {
      if (m.score <= 0) continue;
      const top = [...m.pList].sort((a, b) => b.pts - a.pts)[0];
      if (!top || top.pts <= 0) continue;
      const pct = Math.round((top.pts / m.score) * 100);
      if (pct >= 60) {
        push('gold', '🏋️', `${m.name} has ${pct}% of their pts from one player. ${top.name} is carrying the whole roster.`);
        break;
      }
    }

    const cleanPlayer = withStats.find(p => p.raw.to === 0 && p.played.length >= 2);
    if (cleanPlayer) {
      push('gold', '🧹', `${cleanPlayer.name} played ${cleanPlayer.played.length} rounds without a turnover. Clean. Efficient. Unstoppable.`);
    }

    if (withStats.length > 0 && leader.score > 0) {
      const worstOfLeader = [...leader.pList].sort((a, b) => a.pts - b.pts)[0];
      if (worstOfLeader?.pts > 0) {
        push('gold', '💎', `${leader.name}'s worst player has ${worstOfLeader.pts} pts. Even the bench is producing.`);
      }
    }
  }

  // ── TRASH TALK (crimson) ───────────────────────────────────
  if (hasStats) {
    if (lastPlace.score < leader.score) {
      push('crimson', '💀', `${lastPlace.name} is in last place with ${lastPlace.score} pts. There's still time. Probably.`);
    }

    for (const m of mgrScores) {
      const zeroCnt = m.pList.filter(p => p.pts === 0).length;
      if (zeroCnt >= 2) {
        push('crimson', '😬', `${m.name} has ${zeroCnt} players with 0 pts. The optimism is admirable.`);
        break;
      }
    }

    const topElimMgr = [...mgrScores].sort((a, b) =>
      b.pList.filter(p => p.eliminated).length - a.pList.filter(p => p.eliminated).length
    )[0];
    const topElimCnt = topElimMgr.pList.filter(p => p.eliminated).length;
    if (topElimCnt >= 2) {
      push('crimson', '⚰️', `${topElimMgr.name} has ${topElimCnt} eliminated players. Rough tournament. Really rough.`);
    }

    const gapTotal = round1(leader.score - lastPlace.score);
    if (gapTotal > 15) {
      push('crimson', '📉', `The gap between 1st and last is ${gapTotal} pts. ${lastPlace.name} is not having a good time.`);
    }

    if (mgrScores.length >= 2 && mgrScores[1].score < leader.score) {
      const gap2 = round1(leader.score - mgrScores[1].score);
      if (gap2 > 10) {
        push('crimson', '🔭', `${mgrScores[1].name} is ${gap2} pts behind ${leader.name}. One good game could change everything. Probably won't though.`);
      }
    }

    const elimWithPts = elimPl.filter(p => p.pts > 0).sort((a, b) => b.pts - a.pts);
    if (elimWithPts.length > 0) {
      const e = elimWithPts[0];
      push('crimson', '😔', `${e.name} scored ${e.pts} pts then got eliminated in ${ROUND_SHORT[e.eliminatedRound] || '?'}. ${e.mgrName} felt that.`);
    }

    if (byTO[0]?.raw.to >= 3) {
      const p = byTO[0];
      push('crimson', '🤦', `${p.name} has ${p.raw.to} turnovers this tournament. That's −${p.raw.to} pts handed back. ${p.mgrName} is furious.`);
    }

    if (gapTotal > 30) {
      push('crimson', '🚗', `${lastPlace.name} is ${gapTotal} pts behind the leader. They would need a miracle. Or cheating.`);
    }

    for (const m of mgrScores) {
      const teamCounts = m.pList.reduce((a, p) => { a[p.team] = (a[p.team] || 0) + 1; return a; }, {});
      const [dupTeam, cnt] = Object.entries(teamCounts).sort((a, b) => b[1] - a[1])[0] || [];
      if (cnt >= 2) {
        push('crimson', '🤔', `${m.name} drafted ${cnt} players from ${dupTeam}. Bold strategy. Concerning strategy.`);
        break;
      }
    }

    push('crimson', '💸', `${lastPlace.name} is currently winning $0. Just putting that out there.`);

    if (noStats.length >= 4) {
      push('crimson', '⏳', `${noStats.length} players haven't scored yet. Their managers are waiting nervously.`);
    }

    const badElimCnt = lastPlace.pList.filter(p => p.eliminated).length;
    const lastRank   = mgrScores.findIndex(m => m.id === lastPlace.id) + 1;
    push('crimson', '🚨', `Not to alarm anyone but ${lastPlace.name} is in ${ordinal(lastRank)} place and has ${badElimCnt} eliminated player${badElimCnt !== 1 ? 's' : ''}.`);

    if (leader.score !== lastPlace.score) {
      push('crimson', '🪞', `${leader.name} has ${leader.score} pts. ${lastPlace.name} has ${lastPlace.score} pts. Math is hard for ${lastPlace.name} right now.`);
    }

    if (mgrScores.length >= 2) {
      const secondToLast = mgrScores[mgrScores.length - 2];
      const gapUp = round1(secondToLast.score - lastPlace.score);
      if (gapUp > 5) {
        push('crimson', '🪦', `${secondToLast.name} has ${gapUp} more pts than ${lastPlace.name}. ${lastPlace.name} can see them in the rearview. Wait — no they can't.`);
      }
    }

    const activeLow = activePl.filter(p => p.pts > 0).sort((a, b) => a.pts - b.pts)[0];
    if (activeLow && byPts[0] && activeLow.pts < byPts[0].pts / 4) {
      push('crimson', '🥴', `${activeLow.mgrName} spent a pick on ${activeLow.name} who has contributed ${activeLow.pts} pts. Big swing. Questionable results.`);
    }
  }

  // ── STAT FACTS (blue) ─────────────────────────────────────
  if (hasStats) {
    if (totalPts > 0) {
      push('blue', '📊', `Total fantasy pts scored so far across all managers: ${totalPts}. The tournament is just getting started.`);
    }

    if (bestRound) {
      push('blue', '🎰', `The highest single-round score is ${bestRound.sc} pts by ${bestRound.p.name} in ${ROUND_FULL[bestRound.r.round] || bestRound.r.name}.`);
    }

    push('blue', '🗺️', `${withStats.length} of 25 players have scored. ${elimPl.length} have been eliminated. ${25 - elimPl.length} are still dancing.`);

    if (byBlk[0]?.raw.blk > 0) {
      const p = byBlk[0];
      push('blue', '🏗️', `Blocks are worth 2×. ${p.name} leads with ${p.raw.blk} blocks worth ${round1(p.raw.blk * 2 * p.mul)} fantasy pts.`);
    }

    if (byAst[0]?.raw.ast > 0) {
      const p = byAst[0];
      push('blue', '🎭', `Assists are worth 1.5×. ${p.name} leads with ${p.raw.ast} assists worth ${round1(p.raw.ast * 1.5 * p.mul)} fantasy pts.`);
    }

    if (byStl[0]?.raw.stl > 0) {
      const p = byStl[0];
      push('blue', '🎪', `Steals are worth 2×. ${p.name} has ${p.raw.stl} steals this tournament worth ${round1(p.raw.stl * 2 * p.mul)} fantasy pts.`);
    }

    if (mgrScores.length >= 2 && mgrScores[0].score > 0 && mgrScores[1].score >= 0) {
      const gap = round1(mgrScores[0].score - mgrScores[1].score);
      if (gap > 0) push('blue', '📐', `The gap between 1st and 2nd place is ${gap} pts. ${mgrScores[1].name} needs a big game.`);
    }

    const doubleBonus = round1(pStats.filter(p => p.mul === 2).reduce((s, p) => s + round1(p.pts / 2), 0));
    if (doubleBonus > 0) {
      push('blue', '⚡', `The 2× multiplier has generated ${doubleBonus} extra pts across all Seed 9–16 players.`);
    }

    if (byTO[0]?.raw.to >= 2) {
      const p = byTO[0];
      push('blue', '🔄', `${p.name} leads in turnovers with ${p.raw.to} this tournament. That's −${p.raw.to} pts. Ouch.`);
    }

    if (byReb[0]?.raw.reb > 0) {
      const p = byReb[0];
      push('blue', '📦', `${p.name} has ${p.raw.reb} total rebounds this tournament worth ${round1(p.raw.reb * 1.2 * p.mul)} fantasy pts just from boards.`);
    }

    if (worstRound && withStats.length > 3) {
      push('blue', '📉', `Lowest single-round score: ${worstRound.p.name} with ${worstRound.sc} pts in ${ROUND_FULL[worstRound.r.round] || worstRound.r.name}. It happens.`);
    }

    if (activePl.length > 0 && totalPts > 0) {
      const avg = round1(totalPts / activePl.length);
      const topAct = byPts.find(p => !p.eliminated);
      if (topAct && topAct.pts > avg) {
        push('blue', '📏', `Average pts per active player: ${avg}. ${topAct.name} is well above that at ${topAct.pts}.`);
      }
    }

    if (byPPR[0]?.ppr > 0 && byPPR[0].played.length >= 2) {
      const p = byPPR[0];
      push('blue', '⚡', `${p.name} played ${p.played.length} rounds and scored ${p.pts} total pts — ${p.ppr} pts per round.`);
    }

    if (byAst[0]?.raw.ast > 0) {
      push('blue', '🤝', `Most assists: ${byAst[0].name} with ${byAst[0].raw.ast}. Playmakers score big in this format.`);
    }

    if (byBlk[0]?.raw.blk > 0) {
      push('blue', '🛡️', `Most blocks: ${byBlk[0].name} with ${byBlk[0].raw.blk}. Rim protection is worth 2× here.`);
    }

    if (byStl[0]?.raw.stl > 0) {
      const p = byStl[0];
      push('blue', '🕵️', `Most steals: ${p.name} with ${p.raw.stl} worth ${round1(p.raw.stl * 2 * p.mul)} pts at the 2× rate.`);
    }

    const seed916 = pStats.filter(p => p.mul === 2);
    if (seed916.length > 0) {
      const s = seed916[Math.floor(Math.random() * seed916.length)];
      push('blue', '🎲', `Seeds 9–16 get 2×. ${s.mgrName}'s ${s.name} (Seed ${s.seed}) is worth double every single stat.`);
    }

    const gamesPerRound = [32, 16, 8, 4, 2, 1];
    const maxRound = rounds.length > 0 ? Math.max(...rounds.map(r => r.round)) : 0;
    const gamesPlayed = gamesPerRound.slice(0, maxRound).reduce((s, g) => s + g, 0);
    if (gamesPlayed > 0) {
      push('blue', '🗓️', `${gamesPlayed} tournament games played so far. ${63 - gamesPlayed} more to go before a champion is crowned.`);
    }
  }

  // ── Shuffle ────────────────────────────────────────────────
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  callouts = result;

  const card = document.getElementById('callout-card');
  if (!card) return;

  if (callouts.length < 3) {
    card.classList.remove('visible');
    calloutVisible = false;
    return;
  }

  if (!calloutInitialized) {
    calloutInitialized = true;
    calloutIdx = 0;
    setTimeout(() => _showCallout(true), 1800); // delay on first page load
  } else if (calloutVisible) {
    _applyCallout(callouts[calloutIdx % callouts.length]); // refresh current text
  }
  // If not visible (dismissed), the timer will pick up fresh callouts automatically
}

function _applyCallout(c, animate = false) {
  const textEl   = document.getElementById('callout-text');
  const emojiEl  = document.getElementById('callout-emoji');
  const accentEl = document.getElementById('callout-accent');
  if (!textEl) return;

  const doSwap = () => {
    textEl.textContent  = c.text;
    emojiEl.textContent = c.emoji;
    accentEl.className  = 'callout-accent' + (c.type === 'gold' ? ' gold' : c.type === 'blue' ? ' blue' : '');
  };

  if (animate) {
    textEl.style.opacity  = '0';
    emojiEl.style.opacity = '0';
    setTimeout(() => {
      doSwap();
      textEl.style.opacity  = '1';
      emojiEl.style.opacity = '1';
    }, 130);
  } else {
    doSwap();
  }
}

function _showCallout() {
  if (callouts.length === 0) return;
  const card = document.getElementById('callout-card');
  if (!card) return;

  const c = callouts[calloutIdx % callouts.length];
  calloutIdx = (calloutIdx + 1) % callouts.length;

  _applyCallout(c, false);
  card.style.display = ''; // ensure not hidden
  requestAnimationFrame(() => {
    requestAnimationFrame(() => card.classList.add('visible'));
  });
  calloutVisible = true;
}

function calloutTap() {
  if (!calloutVisible || callouts.length === 0) return;
  const c = callouts[calloutIdx % callouts.length];
  calloutIdx = (calloutIdx + 1) % callouts.length;
  _applyCallout(c, true);
}

function dismissCallout() {
  const card = document.getElementById('callout-card');
  if (!card) return;
  card.classList.remove('visible');
  calloutVisible = false;

  if (calloutTimer) clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => {
    if (callouts.length >= 3) _showCallout();
  }, 30_000);
}

// ─── INIT ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Restore last active tab
  const savedTab = localStorage.getItem('dig_bicken_active_tab');
  if (savedTab && ['draft', 'leaderboard', 'players', 'stats', 'status'].includes(savedTab)) {
    switchTab(savedTab);
  }

  loadData();

  // Auto-refresh every 30 seconds; ESPN sync every 10 minutes during tournament hours
  setInterval(() => loadData(true), 30 * 1000);
  setInterval(() => { if (isTournamentHours()) autoSyncStats(); }, 10 * 60 * 1000);

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  // Password modal — Enter key
  document.getElementById('admin-password-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitPassword(); }
  });

  // Add-player form — Enter key
  document.getElementById('add-player-form').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitAddPlayer(); }
  });

  // Seed change → double-points warning
  document.getElementById('p-seed').addEventListener('input', function () {
    const v = parseInt(this.value);
    document.getElementById('double-warning').style.display =
      (v >= 9 && v <= 16) ? 'block' : 'none';
  });
});
