// server.js — RD-SSAAT Full Stack
require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const path        = require('path');

// ── Fail fast on missing required config ──────────────
// Previously, a missing JWT_SECRET wasn't checked here — jwt.sign()/verify()
// would throw a raw, confusing error on the very first login attempt instead
// of a clear startup message. Check it up front.
if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET is not set. Set it in your environment before starting the server.');
  process.exit(1);
}

const app = express();

// ── Security ──────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.set('trust proxy', 1);

// ── CORS ──────────────────────────────────────────────
const origins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
if (origins.includes('*') && process.env.NODE_ENV === 'production') {
  // ALLOWED_ORIGINS=* combined with credentials:true means any site can send
  // cookies/Authorization headers cross-origin and get a CORS-allowed response.
  // This app uses Bearer tokens (not cookies) so the practical risk is lower,
  // but it's still worth flagging loudly rather than shipping silently open.
  console.warn('⚠️  ALLOWED_ORIGINS=* in production — set this to your actual frontend origin(s).');
}
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origins.includes('*') || origins.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked'));
  },
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────
app.use('/api/auth/login',
  rateLimit({ windowMs: 15*60*1000, max: 10,
    message: { success: false, message: 'Too many login attempts. Wait 15 minutes.' }
  })
);
// Password-recovery is now email-link based (OTP removed from this flow —
// see auth.js). Rate-limit the request step so it can't be used to spam
// someone's inbox or brute-force account enumeration timing.
app.use('/api/auth/forgot-password',
  rateLimit({ windowMs: 15*60*1000, max: 5,
    message: { success: false, message: 'Too many requests. Wait 15 minutes.' }
  })
);
app.use('/api/',
  rateLimit({ windowMs: 60*1000, max: 120,
    message: { success: false, message: 'Rate limit exceeded.' }
  })
);

// ── API Routes (all flat — no subfolders) ─────────────
app.use('/api/auth',       require('./auth'));
app.use('/api/employees',  require('./employees'));
app.use('/api/faces',      require('./faces'));
app.use('/api/attendance', require('./attendance'));
app.use('/api/leaves',     require('./leaves'));
app.use('/api/admin',      require('./admin-routes'));

// ── Health check ──────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  env:    process.env.NODE_ENV,
  time:   new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
}));

// ── Serve Frontend ────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const fs = require('fs');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  // fallback: index.html at root
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  res.status(404).json({ message: 'Frontend not found' });
});

// ── Global error handler ──────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║  RD-SSAAT  |  Govt of Andhra Pradesh  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('🚀  Port    :', PORT);
  console.log('🌍  Env     :', process.env.NODE_ENV || 'development');
  console.log('📡  API     : http://localhost:' + PORT + '/api');
  console.log('🌐  App     : http://localhost:' + PORT);
  console.log('');
});

module.exports = app;
