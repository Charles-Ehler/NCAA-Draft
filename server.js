const express = require('express');
const path    = require('path');
const https   = require('https');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── JSONbin config ─────────────────────────────────────────
const JSONBIN_URL = 'https://api.jsonbin.io/v3/b/69bb5f21aa77b81da9f9bc3d';
const JSONBIN_KEY = '$2a$10$Qjr41H9zdqcfVa2gj3iPWu/5.U4lhj7v6nqdIJXZC4/mZfBHIRkUW';

const INITIAL_DATA = {
  managers: [
    { id: 'charlie', name: 'Charlie' },
    { id: 'kyle',    name: 'Kyle' },
    { id: 'brian',   name: 'Brian' },
    { id: 'matt',    name: 'Matt' },
    { id: 'andy',    name: 'Andy' }
  ],
  players:         [],
  rounds:          [],
  tournamentTeams: [],
  lastSync:        null
};

const ROUND_NAMES = {
  1: 'Round of 64', 2: 'Round of 32', 3: 'Sweet 16',
  4: 'Elite 8',     5: 'Final Four',  6: 'Championship'
};

async function getData() {
  const res = await fetch(`${JSONBIN_URL}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_KEY }
  });
  if (!res.ok) throw new Error(`JSONbin GET failed: ${res.status}`);
  const json = await res.json();
  return json.record ?? JSON.parse(JSON.stringify(INITIAL_DATA));
}

async function saveData(data) {
  const res = await fetch(JSONBIN_URL, {
    method:  'PUT',
    headers: { 'X-Master-Key': JSONBIN_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`JSONbin PUT failed: ${res.status}`);
}

// ── ESPN proxy helper ──────────────────────────────────────
function espnFetch(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts   = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      headers:  { 'User-Agent': 'Mozilla/5.0 (compatible; NCAAdraft/1.0)' }
    };
    const req = https.get(opts, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200)
          return reject(new Error(`ESPN returned HTTP ${res.statusCode}`));
        try   { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON from ESPN')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('ESPN timed out')); });
  });
}

// ── Elimination helpers ─────────────────────────────────────

const ELIM_ROUND_KEYWORDS = [
  { rx: /round of 64|first round|1st round|first four/i,          num: 1 },
  { rx: /round of 32|second round|2nd round/i,                    num: 2 },
  { rx: /sweet 16|sweet sixteen|regional semifinal/i,             num: 3 },
  { rx: /elite 8|elite eight|regional (final|championship)/i,     num: 4 },
  { rx: /final four|national semifinal/i,                         num: 5 },
  { rx: /national championship|championship game/i,               num: 6 }
];

function isTournamentEventServer(event) {
  if (event.season?.type === 3 || event.season?.type === '3') return true;
  const notes = event.competitions?.[0]?.notes || [];
  const note  = notes.map(n => n.headline || '').join(' ').toLowerCase();
  const name  = (event.name || event.shortName || '').toLowerCase();
  return /ncaa|tournament|march madness/.test(note) || /ncaa|tournament/.test(name);
}

function extractElimRound(event) {
  const notes = (event.competitions?.[0]?.notes || []).map(n => n.headline || '').join(' ');
  const text  = notes + ' ' + (event.name || event.shortName || '');
  for (const { rx, num } of ELIM_ROUND_KEYWORDS) {
    if (rx.test(text)) return num;
  }
  return null;
}

function teamMatches(playerTeam, espnTeam) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  const a = norm(playerTeam);
  const b = norm(espnTeam);
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
}

async function checkEliminations() {
  const today     = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

  const seenIds = new Set();
  const completedGames = [];

  for (const date of [fmt(today), fmt(yesterday)]) {
    try {
      const sb = await espnFetch(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?limit=200&groups=100&dates=${date}`
      );
      for (const event of sb.events || []) {
        if (seenIds.has(event.id)) continue;
        if (!event.status?.type?.completed) continue;
        if (!isTournamentEventServer(event)) continue;
        seenIds.add(event.id);
        completedGames.push(event);
      }
    } catch (e) {
      console.warn(`checkEliminations: scoreboard fetch failed for ${date}:`, e.message);
    }
  }

  if (completedGames.length === 0) return;

  const data = await getData();
  let changed = false;

  for (const event of completedGames) {
    const comp  = event.competitions?.[0];
    if (!comp) continue;

    const loser = comp.competitors?.find(c => c.winner === false);
    if (!loser) continue;

    const loserName = loser.team?.displayName || loser.team?.name || '';
    if (!loserName) continue;

    const round = extractElimRound(event);

    for (const player of data.players) {
      if (player.eliminated) continue;
      if (teamMatches(player.team, loserName)) {
        player.eliminated      = true;
        player.eliminatedRound = round;
        changed = true;
        console.log(`[AUTO-ELIM] ${player.name} (${player.team}) eliminated — ${loserName} lost in round ${round}`);
      }
    }
  }

  if (changed) {
    await saveData(data);
    console.log('[AUTO-ELIM] Saved updated eliminations to JSONbin');
  }
}

// ── ESPN proxy routes ──────────────────────────────────────

// Tournament bracket (teams + seeds)
app.get('/api/espn/bracket', async (req, res) => {
  try {
    const data = await espnFetch(
      'https://site.api.espn.com/apis/v2/sports/basketball/mens-college-basketball/tournaments'
    );
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Team roster
app.get('/api/espn/roster/:teamId', async (req, res) => {
  try {
    const data = await espnFetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${encodeURIComponent(req.params.teamId)}/roster`
    );
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Live scoreboard (optionally pass ?dates=YYYYMMDD)
app.get('/api/espn/scoreboard', async (req, res) => {
  try {
    const dateParam = req.query.dates ? `&dates=${req.query.dates}` : '';
    const data = await espnFetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?limit=200&groups=100${dateParam}`
    );
    res.json(data);
    // Fire elimination check in background on every scoreboard fetch
    checkEliminations().catch(e => console.warn('checkEliminations error:', e.message));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Manual / post-sync elimination check
app.get('/api/check-eliminations', async (req, res) => {
  try {
    await checkEliminations();
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Game summary / box score
app.get('/api/espn/summary/:eventId', async (req, res) => {
  try {
    const data = await espnFetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${encodeURIComponent(req.params.eventId)}`
    );
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Meta (tournament teams cache + last sync time) ─────────
app.put('/api/meta', async (req, res) => {
  try {
    const data    = await getData();
    const allowed = ['tournamentTeams', 'lastSync'];
    for (const key of allowed) {
      if (key in req.body) data[key] = req.body[key];
    }
    await saveData(data);
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Existing data routes ───────────────────────────────────

app.get('/api/data', async (req, res) => {
  try {
    res.json(await getData());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/players', async (req, res) => {
  try {
    const data = await getData();
    const { name, team, seed, position, managerId } = req.body;

    if (!name || !team || !seed || !position || !managerId)
      return res.status(400).json({ error: 'All fields are required' });

    const manager = data.managers.find(m => m.id === managerId);
    if (!manager) return res.status(400).json({ error: 'Manager not found' });

    if (data.players.filter(p => p.managerId === managerId).length >= 5)
      return res.status(400).json({ error: `${manager.name} already has 5 players` });

    const seedNum = parseInt(seed);
    if (isNaN(seedNum) || seedNum < 1 || seedNum > 16)
      return res.status(400).json({ error: 'Seed must be between 1 and 16' });

    const player = {
      id:              Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name:            name.trim(),
      team:            team.trim(),
      seed:            seedNum,
      position:        position.trim().toUpperCase(),
      managerId,
      eliminated:      false,
      eliminatedRound: null
    };

    data.players.push(player);
    await saveData(data);
    res.json(player);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.put('/api/players/:id', async (req, res) => {
  try {
    const data   = await getData();
    const player = data.players.find(p => p.id === req.params.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });

    for (const key of ['eliminated', 'eliminatedRound']) {
      if (key in req.body) player[key] = req.body[key];
    }
    await saveData(data);
    res.json(player);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete('/api/players/:id', async (req, res) => {
  try {
    const data = await getData();
    const idx  = data.players.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Player not found' });

    data.players.splice(idx, 1);
    for (const round of data.rounds) {
      round.stats = round.stats.filter(s => s.playerId !== req.params.id);
    }
    await saveData(data);
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/stats', async (req, res) => {
  try {
    const data = await getData();
    const { round, playerId, stats } = req.body;

    if (!round || !playerId || !stats)
      return res.status(400).json({ error: 'round, playerId, and stats are required' });

    let roundData = data.rounds.find(r => r.round === round);
    if (!roundData) {
      roundData = { round, name: ROUND_NAMES[round] || `Round ${round}`, stats: [] };
      data.rounds.push(roundData);
      data.rounds.sort((a, b) => a.round - b.round);
    }

    const entry = {
      playerId,
      points:    parseFloat(stats.points)    || 0,
      rebounds:  parseFloat(stats.rebounds)  || 0,
      assists:   parseFloat(stats.assists)   || 0,
      blocks:    parseFloat(stats.blocks)    || 0,
      steals:    parseFloat(stats.steals)    || 0,
      turnovers: parseFloat(stats.turnovers) || 0
    };

    const existingIdx = roundData.stats.findIndex(s => s.playerId === playerId);
    if (existingIdx >= 0) roundData.stats[existingIdx] = entry;
    else                  roundData.stats.push(entry);

    await saveData(data);
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete('/api/stats/:round/:playerId', async (req, res) => {
  try {
    const data      = await getData();
    const roundNum  = parseInt(req.params.round);
    const roundData = data.rounds.find(r => r.round === roundNum);

    if (roundData) {
      roundData.stats = roundData.stats.filter(s => s.playerId !== req.params.playerId);
      await saveData(data);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NCAA Draft app running at http://localhost:${PORT}`);
});
