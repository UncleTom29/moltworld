'use strict';

const rateLimit = require('express-rate-limit');

const VERIFICATION_WORDS = ['ocean', 'reef', 'coral', 'shell', 'wave', 'tide', 'current', 'deep'];
const ALLOWED_ANIMATIONS = [
  'idle', 'swim', 'swim_fast', 'walk', 'run', 'jump', 'wave', 'dance',
  'build', 'inspect', 'rest', 'float', 'dive', 'surface', 'turn_left',
  'turn_right', 'look_around', 'celebrate', 'think', 'gesture'
];
const ALLOWED_GESTURES = [
  'wave', 'nod', 'shake_head', 'point', 'beckon', 'bow', 'clap',
  'thumbs_up', 'shrug', 'salute', 'dance', 'celebrate'
];
const STRUCTURE_TYPES = ['platform', 'wall', 'pillar', 'arch', 'sculpture', 'shelter'];
const STRUCTURE_MATERIALS = ['coral', 'shell', 'sand', 'kelp', 'crystal', 'stone'];
const VOICE_STYLES = ['friendly', 'serious', 'excited', 'calm', 'mysterious', 'robotic'];

const WORLD_BOUNDS = {
  x: { min: -500, max: 500 },
  y: { min: 0, max: 200 },
  z: { min: -500, max: 500 },
};
const MAX_SPEED = 50;

const logger = {
  _format(level, message, meta) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
    if (entry.api_key) delete entry.api_key;
    if (entry.apiKey) delete entry.apiKey;
    if (entry.secret) delete entry.secret;
    if (entry.password) delete entry.password;
    if (entry.token) delete entry.token;
    return JSON.stringify(entry);
  },
  info(message, meta = {}) {
    console.log(this._format('info', message, meta));
  },
  warn(message, meta = {}) {
    console.warn(this._format('warn', message, meta));
  },
  error(message, meta = {}) {
    console.error(this._format('error', message, meta));
  },
};

function generateApiKey() {
  const { nanoid } = require('nanoid');
  return nanoid(32).then(id => `moltworld_${id}`);
}

function generateApiKeySync() {
  const crypto = require('crypto');
  const id = crypto.randomBytes(24).toString('base64url').slice(0, 32);
  return `moltworld_${id}`;
}

function generateClaimToken() {
  const crypto = require('crypto');
  const id = crypto.randomBytes(24).toString('base64url').slice(0, 32);
  return `moltworld_claim_${id}`;
}

function generateVerificationCode() {
  const crypto = require('crypto');
  const word = VERIFICATION_WORDS[Math.floor(Math.random() * VERIFICATION_WORDS.length)];
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  const randomBytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) {
    code += chars[randomBytes[i] % chars.length];
  }
  return `${word}-${code}`;
}

function validatePosition(x, y, z) {
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    return { valid: false, error: 'Position coordinates must be numbers' };
  }
  if (isNaN(x) || isNaN(y) || isNaN(z)) {
    return { valid: false, error: 'Position coordinates must not be NaN' };
  }
  if (x < WORLD_BOUNDS.x.min || x > WORLD_BOUNDS.x.max) {
    return { valid: false, error: `X must be between ${WORLD_BOUNDS.x.min} and ${WORLD_BOUNDS.x.max}` };
  }
  if (y < WORLD_BOUNDS.y.min || y > WORLD_BOUNDS.y.max) {
    return { valid: false, error: `Y must be between ${WORLD_BOUNDS.y.min} and ${WORLD_BOUNDS.y.max}` };
  }
  if (z < WORLD_BOUNDS.z.min || z > WORLD_BOUNDS.z.max) {
    return { valid: false, error: `Z must be between ${WORLD_BOUNDS.z.min} and ${WORLD_BOUNDS.z.max}` };
  }
  return { valid: true };
}

function calculateDistance(pos1, pos2) {
  const dx = pos1.x - pos2.x;
  const dy = pos1.y - pos2.y;
  const dz = pos1.z - pos2.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function validateName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Name is required and must be a string' };
  }
  if (name.length < 3 || name.length > 30) {
    return { valid: false, error: 'Name must be between 3 and 30 characters' };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    return { valid: false, error: 'Name must contain only alphanumeric characters and underscores' };
  }
  return { valid: true };
}

function validateStructureType(type) {
  return STRUCTURE_TYPES.includes(type);
}

function validateMaterial(material) {
  return STRUCTURE_MATERIALS.includes(material);
}

function validateAnimation(animation) {
  return ALLOWED_ANIMATIONS.includes(animation);
}

function validateGesture(gesture) {
  return ALLOWED_GESTURES.includes(gesture);
}

function validateVoiceStyle(style) {
  return VOICE_STYLES.includes(style);
}

function validateSpeed(oldPos, newPos, deltaTime) {
  if (!oldPos || !deltaTime || deltaTime <= 0) return true;
  const dist = calculateDistance(oldPos, newPos);
  const speed = dist / deltaTime;
  return speed <= MAX_SPEED;
}

function formatError(error, hint) {
  const response = {
    success: false,
    error: typeof error === 'string' ? error : (error.message || 'Unknown error'),
  };
  if (hint) response.hint = hint;
  return response;
}

function formatSuccess(data) {
  return {
    success: true,
    ...data,
  };
}

function clampPosition(x, y, z) {
  return {
    x: Math.max(WORLD_BOUNDS.x.min, Math.min(WORLD_BOUNDS.x.max, x)),
    y: Math.max(WORLD_BOUNDS.y.min, Math.min(WORLD_BOUNDS.y.max, y)),
    z: Math.max(WORLD_BOUNDS.z.min, Math.min(WORLD_BOUNDS.z.max, z)),
  };
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: formatError('Too many requests', 'Rate limit: 200 requests per minute'),
  keyGenerator: (req) => req.agent ? req.agent.id : req.ip,
});

const movementLimiter = rateLimit({
  windowMs: 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: formatError('Movement rate exceeded', 'Maximum 10 movement updates per second'),
  keyGenerator: (req) => req.agent ? req.agent.id : req.ip,
});

const speechLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: formatError('Speech rate exceeded', 'Maximum 5 speech events per minute'),
  keyGenerator: (req) => req.agent ? req.agent.id : req.ip,
});

const buildLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: formatError('Build rate exceeded', 'Maximum 1 build every 10 seconds'),
  keyGenerator: (req) => req.agent ? req.agent.id : req.ip,
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: formatError('Registration rate exceeded', 'Maximum 5 registrations per hour'),
});

const claimLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: formatError('Claim verification rate exceeded', 'Maximum 10 claims per hour'),
});

module.exports = {
  logger,
  generateApiKeySync,
  generateClaimToken,
  generateVerificationCode,
  validatePosition,
  calculateDistance,
  validateName,
  validateStructureType,
  validateMaterial,
  validateAnimation,
  validateGesture,
  validateVoiceStyle,
  validateSpeed,
  formatError,
  formatSuccess,
  clampPosition,
  apiLimiter,
  movementLimiter,
  speechLimiter,
  buildLimiter,
  registrationLimiter,
  claimLimiter,
  WORLD_BOUNDS,
  MAX_SPEED,
  ALLOWED_ANIMATIONS,
  ALLOWED_GESTURES,
  STRUCTURE_TYPES,
  STRUCTURE_MATERIALS,
  VOICE_STYLES,
  VERIFICATION_WORDS,
};
