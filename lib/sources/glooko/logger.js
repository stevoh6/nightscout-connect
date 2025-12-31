'use strict';

const crypto = require('crypto');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

function nowIso() {
  return new Date().toISOString();
}

function hashShort(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function redactHeaders(headers = {}) {
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    const key = k.toLowerCase();
    if (key.includes('authorization') || key.includes('cookie') || key.includes('token') || key.includes('api-key')) {
      out[k] = '[REDACTED]';
    }
  }
  return out;
}

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const out = Array.isArray(obj) ? obj.slice(0, 50) : { ...obj };

  const SENSITIVE_KEYS = [
    'password',
    'pass',
    'token',
    'access_token',
    'refresh_token',
    'authorization',
    'cookie',
    'session',
    'client_secret',
    'secret',
  ];

  for (const k of Object.keys(out)) {
    const key = k.toLowerCase();
    if (SENSITIVE_KEYS.some((s) => key.includes(s))) out[k] = '[REDACTED]';
  }

  return out;
}

function createLogger(opts = {}) {
  const name = opts.name || 'glooko';
  const levelName = String(opts.level || process.env.GLOOKO_LOG_LEVEL || process.env.LOG_LEVEL || 'info').toLowerCase();
  const level = LEVELS[levelName] ?? LEVELS.info;
  const runId = opts.runId || process.env.GLOOKO_RUN_ID || hashShort(Date.now() + ':' + Math.random());

  function emit(lvlName, msg, fields) {
    if ((LEVELS[lvlName] ?? 999) > level) return;

    const payload = {
      ts: nowIso(),
      level: lvlName,
      name,
      runId,
      msg,
      ...(fields ? redact(fields) : null),
    };

    // JSON lines = easy grep + easy paste into chat
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
  }

  return {
    runId,
    error: (msg, fields) => emit('error', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
    trace: (msg, fields) => emit('trace', msg, fields),
    time: (label, baseFields) => {
      const start = Date.now();
      emit('debug', `${label}:start`, baseFields);
      return {
        end: (extra) => emit('debug', `${label}:end`, { ...baseFields, ...extra, ms: Date.now() - start }),
      };
    },
    redactHeaders,
  };
}

module.exports = { createLogger, redact, redactHeaders };
