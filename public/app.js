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
    if (bar) { bar.style.width = '100%'; setTimeout(() => { bar.style.width = '0%'; bar.classList.remove('active'); }, 300); }
  } catch (e) {
    if (bar) { bar.style.width = '0%'; bar.classList.remove('active'); }
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
  if (tab === 'stats')   renderStats();
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
          <span class="draft-mgr-score">${players.length}/5 · ${score > 0 ? score + 'pts' : '0pts'}</span>
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
        <div class="player-meta">${esc(p.position)} · ${esc(p.team)}${p.eliminated ? ` · <span style="color:var(--gray-400)">Out R${p.eliminatedRound || '?'}</span>` : ''}</div>
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
          const contrib  = m.score > 0 ? Math.round((pScore / m.score) * 100) : 0;
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
                <div class="lb-player-name">${esc(p.name)}</div>
                <div class="lb-player-sub">${esc(p.position)} · ${esc(p.team)}${p.eliminated ? ` · <span style="color:var(--gray-400)">Out R${p.eliminatedRound||'?'}</span>` : ''}</div>
              </div>
              <div class="lb-player-pts ${ptsClass}">
                ${pScore !== 0 ? pScore : '—'}
                ${pScore !== 0 && m.score > 0 ? `<span class="pts-contrib">${contrib}%</span>` : ''}
              </div>
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
          <div class="stats-player-item ${hasStats ? 'has-stats' : ''}" onclick="openStatsModal('${p.id}', ${currentRound})">
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
                    ${p.eliminated
                      ? `<span class="out-tag">Out R${p.eliminatedRound || '?'}</span>
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
        s.points    ? `${s.points} pts`                         : '',
        s.rebounds  ? `${s.rebounds} reb`                       : '',
        s.assists   ? `${s.assists} ast`                        : '',
        s.blocks    ? `${s.blocks} blk`                         : '',
        s.steals    ? `${s.steals} stl`                         : '',
        s.turnovers ? `${s.turnovers} to`                       : ''
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
              ${p.eliminated ? `<span class="pl-out-badge">Out R${p.eliminatedRound || '?'}</span>` : ''}
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
  const now = new Date();
  const diffMin = Math.round((now - d) / 60000);

  if (diffMin < 1)        el.textContent = 'Updated just now';
  else if (diffMin < 60)  el.textContent = `Updated ${diffMin}m ago`;
  else                    el.textContent = `Updated ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ─── STATS MODAL ──────────────────────────────────────────

// Public entry point — gated by admin
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
    ${player.eliminated ? `<div class="ptt-elim">❌ Eliminated Round ${player.eliminatedRound || '?'}</div>` : ''}
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

// ─── INIT ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
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
