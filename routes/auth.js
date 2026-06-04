const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');

const USERS_FILE = path.join(__dirname, '../data/users.json');

function read()      { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
function write(data) { fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2)); }
function hash(pw)    { return crypto.createHash('sha256').update(pw + 'smartrider_salt').digest('hex'); }
function makeToken() { return crypto.randomBytes(32).toString('hex'); }

// POST /api/auth/signup
router.post('/signup', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name required' });

  const users = read();
  if (users.find(u => u.email === email)) return res.status(409).json({ error: 'Email already registered' });

  const user = { id: `usr-${uuidv4().slice(0,8)}`, email, name, password: hash(password), token: makeToken(), createdAt: new Date().toISOString() };
  users.push(user);
  write(users);
  res.status(201).json({ id: user.id, email: user.email, name: user.name, token: user.token });
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const users = read();
  const user  = users.find(u => u.email === email && u.password === hash(password));
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  user.token = makeToken();
  write(users);
  res.json({ id: user.id, email: user.email, name: user.name, token: user.token });
});

// GET /api/auth/me  (token in Authorization header)
router.get('/me', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user  = read().find(u => u.token === token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ id: user.id, email: user.email, name: user.name });
});

module.exports = router;
