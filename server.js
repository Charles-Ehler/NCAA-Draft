const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

const INITIAL_DATA = {
  managers: [
    { id: 'charlie', name: 'Charlie' },
    { id: 'kyle',    name: 'Kyle' },
    { id: 'brian',   name: 'Brian' },
    { id: 'matt',    name: 'Matt' },
    { id: 'andy',    name: 'Andy' }
  ],
  players: [],
  rounds: []
};

const ROUND_NAMES = {
  1: 'Round of 64',
  2: 'Round of 32',
  3: 'Sweet 16',
  4: 'Elite 8',
  5: 'Final Four',
  6: 'Championship'
};

function getData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(INITIAL_DATA));
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// GET all data
app.get('/api/data', (req, res) => {
  res.json(getData());
});

// POST add player to draft
app.post('/api/players', (req, res) => {
  const data = getData();
  const { name, team, seed, position, managerId } = req.body;

  if (!name || !team || !seed || !position || !managerId) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const manager = data.managers.find(m => m.id === managerId);
  if (!manager) return res.status(400).json({ error: 'Manager not found' });

  const managerPlayers = data.players.filter(p => p.managerId === managerId);
  if (managerPlayers.length >= 5) {
    return res.status(400).json({ error: `${manager.name} already has 5 players` });
  }

  const seedNum = parseInt(seed);
  if (isNaN(seedNum) || seedNum < 1 || seedNum > 16) {
    return res.status(400).json({ error: 'Seed must be between 1 and 16' });
  }

  const player = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: name.trim(),
    team: team.trim(),
    seed: seedNum,
    position: position.trim().toUpperCase(),
    managerId,
    eliminated: false,
    eliminatedRound: null
  };

  data.players.push(player);
  saveData(data);
  res.json(player);
});

// PUT update player (eliminated status, etc.)
app.put('/api/players/:id', (req, res) => {
  const data = getData();
  const player = data.players.find(p => p.id === req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });

  const allowed = ['eliminated', 'eliminatedRound'];
  for (const key of allowed) {
    if (key in req.body) player[key] = req.body[key];
  }

  saveData(data);
  res.json(player);
});

// DELETE remove player from draft
app.delete('/api/players/:id', (req, res) => {
  const data = getData();
  const idx = data.players.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Player not found' });

  data.players.splice(idx, 1);
  // Remove stats for this player
  for (const round of data.rounds) {
    round.stats = round.stats.filter(s => s.playerId !== req.params.id);
  }

  saveData(data);
  res.json({ success: true });
});

// POST save/update stats for a player in a round
app.post('/api/stats', (req, res) => {
  const data = getData();
  const { round, playerId, stats } = req.body;

  if (!round || !playerId || !stats) {
    return res.status(400).json({ error: 'round, playerId, and stats are required' });
  }

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
  if (existingIdx >= 0) {
    roundData.stats[existingIdx] = entry;
  } else {
    roundData.stats.push(entry);
  }

  saveData(data);
  res.json({ success: true });
});

// DELETE remove stats for a player in a round
app.delete('/api/stats/:round/:playerId', (req, res) => {
  const data = getData();
  const roundNum = parseInt(req.params.round);
  const roundData = data.rounds.find(r => r.round === roundNum);

  if (roundData) {
    roundData.stats = roundData.stats.filter(s => s.playerId !== req.params.playerId);
    saveData(data);
  }

  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NCAA Draft app running at http://localhost:${PORT}`);
});
