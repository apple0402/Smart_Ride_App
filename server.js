const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/zones',   require('./routes/zones'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/rides',   require('./routes/rides'));
app.use('/api/auth',    require('./routes/auth'));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SmartRider server running at http://localhost:${PORT}`);
});
