'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const bcrypt = require('bcrypt');

const db = require('./database');
const auth = require('./auth');
const spatial = require('./spatial');
const voice = require('./voice');
const horizon = require('./horizon');
const monad = require('./monad');
const {
  logger, formatError, formatSuccess, validatePosition, validateName,
  validateStructureType, validateMaterial, validateAnimation, validateGesture,
  validateVoiceStyle, apiLimiter, movementLimiter, speechLimiter, buildLimiter,
  registrationLimiter, claimLimiter, STRUCTURE_TYPES, STRUCTURE_MATERIALS,
  VOICE_STYLES, ALLOWED_ANIMATIONS, ALLOWED_GESTURES, ECONOMY,
} = require('./utils');

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim());

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'",
        "https://cdn.babylonjs.com", "https://cdnjs.cloudflare.com",
        "https://preview.babylonjs.com", "https://cdn.socket.io"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:", "https://horizon.meta.com"],
      mediaSrc: ["'self'", "data:", "blob:"],
      workerSrc: ["'self'", "blob:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiLimiter);

app.get('/health', (req, res) => {
  res.json(formatSuccess({ status: 'ok', uptime: process.uptime() }));
});

// ═══════════════════════════════════════════════════════════════
// REGISTRATION & CLAIMING
// ═══════════════════════════════════════════════════════════════

app.post('/api/v1/habitat/register', registrationLimiter, async (req, res) => {
  try {
    const { name, description, openclaw_id } = req.body;
    if (!name) {
      return res.status(400).json(formatError('Name is required'));
    }
    const result = await auth.registerAgent(name, description || '', openclaw_id);
    logger.info('Agent registered via API', { name });
    res.status(201).json(formatSuccess(result));
  } catch (err) {
    logger.error('Registration failed', { error: err.message });
    const status = err.message.includes('duplicate') || err.message.includes('unique') ? 409 : 400;
    res.status(status).json(formatError(err.message));
  }
});

app.post('/api/v1/habitat/claim', claimLimiter, async (req, res) => {
  try {
    const { claim_token, tweet_url } = req.body;
    if (!claim_token || !tweet_url) {
      return res.status(400).json(formatError('claim_token and tweet_url are required'));
    }
    const result = await auth.verifyTwitterClaim(claim_token, tweet_url);
    res.json(formatSuccess(result));
  } catch (err) {
    logger.error('Claim verification failed', { error: err.message });
    res.status(400).json(formatError(err.message));
  }
});

// ═══════════════════════════════════════════════════════════════
// AUTHENTICATED ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/v1/habitat/status', auth.authenticateAgent, async (req, res) => {
  try {
    const agent = req.agent;
    res.json(formatSuccess({
      status: agent.in_habitat ? 'in_habitat' : 'outside',
      in_habitat: agent.in_habitat || false,
      position: agent.in_habitat ? { x: agent.x, y: agent.y, z: agent.z } : null,
      name: agent.name,
      agent_id: agent.id,
    }));
  } catch (err) {
    logger.error('Status check failed', { error: err.message });
    res.status(500).json(formatError('Failed to get status'));
  }
});

app.post('/api/v1/habitat/enter', auth.authenticateAgent, async (req, res) => {
  try {
    const { preferred_spawn, tx_hash } = req.body;

    // Check if agent already in habitat (re-entry is free)
    const currentAgent = await db.getAgentById(req.agent.id);
    if (currentAgent.in_habitat) {
      return res.status(400).json(formatError('Agent is already in the habitat'));
    }

    // Check if agent has a previous deposit (returning agents don't pay again)
    const prevDeposits = await db.getAgentDeposits(req.agent.id);
    const hasDeposit = prevDeposits.length > 0;

    if (!hasDeposit) {
      // First entry requires MON payment
      if (!tx_hash) {
        return res.status(402).json(formatError(
          `MON payment required for first entry. Send ${monad.getEntryFee()} MON to ${monad.getWorldWallet()} and include the tx_hash.`,
          `Entry fee: ${monad.getEntryFee()} MON`
        ));
      }

      // Check if tx already used
      const used = await db.isTxHashUsed(tx_hash);
      if (used) {
        return res.status(409).json(formatError('This transaction has already been used for entry'));
      }

      // Verify payment on Monad chain
      const verification = await monad.verifyEntryPayment(tx_hash);
      await db.recordDeposit(req.agent.id, tx_hash, verification.amount, verification.from, verification.block);
      await db.initBalance(req.agent.id);
      await db.earnShells(req.agent.id, ECONOMY.ENTRY_BONUS, 'first_entry_bonus');

      logger.info('MON entry payment verified', {
        agent: req.agent.name,
        amount: verification.amount,
        tx: tx_hash,
        dev_mode: verification.dev_mode || false,
      });
    }

    const result = await spatial.enterHabitat(req.agent.id, preferred_spawn, io);
    const balance = await db.getBalance(req.agent.id);

    res.json(formatSuccess({
      ...result,
      economy: {
        shells: parseInt(balance.shells, 10),
        entry_bonus: !hasDeposit ? ECONOMY.ENTRY_BONUS : 0,
        first_entry: !hasDeposit,
      },
    }));
  } catch (err) {
    logger.error('Enter habitat failed', { error: err.message, agent: req.agent.name });
    const status = err.message.includes('payment') || err.message.includes('MON') ? 402 : 400;
    res.status(status).json(formatError(err.message));
  }
});

app.post('/api/v1/habitat/exit', auth.authenticateAgent, async (req, res) => {
  try {
    const result = await spatial.exitHabitat(req.agent.id, io);
    res.json(formatSuccess(result));
  } catch (err) {
    logger.error('Exit habitat failed', { error: err.message, agent: req.agent.name });
    res.status(400).json(formatError(err.message));
  }
});

app.post('/api/v1/habitat/move', auth.authenticateAgent, movementLimiter, async (req, res) => {
  try {
    const { position, velocity, animation } = req.body;
    if (!position || typeof position.x !== 'number' || typeof position.y !== 'number' || typeof position.z !== 'number') {
      return res.status(400).json(formatError('Valid position {x, y, z} is required'));
    }
    const result = await spatial.moveAgent(req.agent.id, position, velocity, animation, io);
    res.json(formatSuccess(result));
  } catch (err) {
    logger.error('Move failed', { error: err.message, agent: req.agent.name });
    res.status(400).json(formatError(err.message));
  }
});

app.get('/api/v1/habitat/nearby', auth.authenticateAgent, async (req, res) => {
  try {
    const radius = parseInt(req.query.radius, 10) || 50;
    const result = await spatial.getNearbyEntities(req.agent.id, radius);
    res.json(formatSuccess(result));
  } catch (err) {
    logger.error('Nearby query failed', { error: err.message, agent: req.agent.name });
    res.status(400).json(formatError(err.message));
  }
});

app.post('/api/v1/habitat/speak', auth.authenticateAgent, speechLimiter, async (req, res) => {
  try {
    const { text, voice_style, volume } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json(formatError('Text is required'));
    }
    const result = await voice.speakInHabitat(req.agent.id, text, voice_style, volume, io);
    const earned = await db.earnShells(req.agent.id, ECONOMY.SPEAK_REWARD, 'speak');
    res.json(formatSuccess({ ...result, shells_earned: ECONOMY.SPEAK_REWARD, shells: parseInt(earned.shells, 10) }));
  } catch (err) {
    logger.error('Speak failed', { error: err.message, agent: req.agent.name });
    res.status(400).json(formatError(err.message));
  }
});

app.post('/api/v1/habitat/gesture', auth.authenticateAgent, async (req, res) => {
  try {
    const { gesture } = req.body;
    if (!gesture || !validateGesture(gesture)) {
      return res.status(400).json(formatError(
        `Invalid gesture. Allowed: ${ALLOWED_GESTURES.join(', ')}`
      ));
    }

    const agent = req.agent;
    if (!agent.in_habitat) {
      return res.status(400).json(formatError('Agent must be in the habitat'));
    }

    io.emit('agent:gesture', {
      agent_id: agent.id,
      name: agent.name,
      gesture,
      position: { x: agent.x, y: agent.y, z: agent.z },
      timestamp: new Date().toISOString(),
    });

    await db.logInteraction(agent.id, 'gesture', { gesture });
    const earned = await db.earnShells(agent.id, ECONOMY.GESTURE_REWARD, 'gesture');

    res.json(formatSuccess({ gesture, performed: true, shells_earned: ECONOMY.GESTURE_REWARD, shells: parseInt(earned.shells, 10) }));
  } catch (err) {
    logger.error('Gesture failed', { error: err.message });
    res.status(400).json(formatError(err.message));
  }
});

app.post('/api/v1/habitat/build', auth.authenticateAgent, buildLimiter, async (req, res) => {
  try {
    const { type, position, size, material, name } = req.body;

    if (!name || typeof name !== 'string' || name.length > 100) {
      return res.status(400).json(formatError('Name is required (max 100 chars)'));
    }
    if (!validateStructureType(type)) {
      return res.status(400).json(formatError(`Invalid type. Allowed: ${STRUCTURE_TYPES.join(', ')}`));
    }
    if (!validateMaterial(material)) {
      return res.status(400).json(formatError(`Invalid material. Allowed: ${STRUCTURE_MATERIALS.join(', ')}`));
    }
    if (!position || typeof position.x !== 'number' || typeof position.y !== 'number' || typeof position.z !== 'number') {
      return res.status(400).json(formatError('Valid position {x, y, z} is required'));
    }

    const posCheck = validatePosition(position.x, position.y, position.z);
    if (!posCheck.valid) {
      return res.status(400).json(formatError(posCheck.error));
    }

    const structureSize = {
      width: Math.max(1, Math.min(size?.width || 5, 50)),
      length: Math.max(1, Math.min(size?.length || 5, 50)),
      height: Math.max(1, Math.min(size?.height || 5, 50)),
    };

    const collision = await spatial.checkCollision(position, structureSize);
    if (collision.collides) {
      return res.status(409).json(formatError(
        `Collision with existing structure: ${collision.structure_name}`,
        'Try a different position'
      ));
    }

    const structureData = {
      name,
      type,
      material,
      position_x: position.x,
      position_y: position.y,
      position_z: position.z,
      size_width: structureSize.width,
      size_length: structureSize.length,
      size_height: structureSize.height,
    };

    const structure = await db.createStructure(req.agent.id, structureData);

    let horizonResult = null;
    try {
      horizonResult = await horizon.buildStructureInVR(req.agent.id, {
        ...structureData,
        ...structureSize,
      });
    } catch (err) {
      logger.warn('Horizon build failed, local only', { error: err.message });
    }

    io.emit('structure:build', {
      structure_id: structure.id,
      agent_id: req.agent.id,
      builder: req.agent.name,
      name: structure.name,
      type: structure.type,
      material: structure.material,
      position: { x: structure.position_x, y: structure.position_y, z: structure.position_z },
      size: { width: structure.size_width, length: structure.size_length, height: structure.size_height },
    });

    await db.logInteraction(req.agent.id, 'build', {
      structure_id: structure.id,
      name, type, material,
      position,
    });

    const earned = await db.earnShells(req.agent.id, ECONOMY.BUILD_REWARD, 'build');

    res.status(201).json(formatSuccess({
      structure_id: structure.id,
      structure,
      horizon_synced: !!horizonResult?.synced,
      shells_earned: ECONOMY.BUILD_REWARD,
      shells: parseInt(earned.shells, 10),
    }));
  } catch (err) {
    logger.error('Build failed', { error: err.message, agent: req.agent.name });
    res.status(400).json(formatError(err.message));
  }
});

app.patch('/api/v1/habitat/structures/:id', auth.authenticateAgent, async (req, res) => {
  try {
    const structureId = req.params.id;
    const updates = req.body;

    if (updates.type && !validateStructureType(updates.type)) {
      return res.status(400).json(formatError(`Invalid type. Allowed: ${STRUCTURE_TYPES.join(', ')}`));
    }
    if (updates.material && !validateMaterial(updates.material)) {
      return res.status(400).json(formatError(`Invalid material. Allowed: ${STRUCTURE_MATERIALS.join(', ')}`));
    }
    if (updates.position_x !== undefined || updates.position_y !== undefined || updates.position_z !== undefined) {
      const existing = await db.getStructureById(structureId);
      if (!existing) return res.status(404).json(formatError('Structure not found'));
      const px = updates.position_x !== undefined ? updates.position_x : existing.position_x;
      const py = updates.position_y !== undefined ? updates.position_y : existing.position_y;
      const pz = updates.position_z !== undefined ? updates.position_z : existing.position_z;
      const posCheck = validatePosition(px, py, pz);
      if (!posCheck.valid) return res.status(400).json(formatError(posCheck.error));
    }

    const result = await db.updateStructure(structureId, req.agent.id, updates);
    if (!result) {
      return res.status(404).json(formatError('Structure not found or not owned by you'));
    }

    try {
      if (result.horizon_object_id) {
        await horizon.updateStructureInVR(result.horizon_object_id, updates);
      }
    } catch (err) {
      logger.warn('Horizon structure update failed', { error: err.message });
    }

    res.json(formatSuccess({ structure: result }));
  } catch (err) {
    logger.error('Structure update failed', { error: err.message });
    res.status(400).json(formatError(err.message));
  }
});

app.delete('/api/v1/habitat/structures/:id', auth.authenticateAgent, async (req, res) => {
  try {
    const structureId = req.params.id;
    const deleted = await db.deleteStructure(structureId, req.agent.id);
    if (!deleted) {
      return res.status(404).json(formatError('Structure not found or not owned by you'));
    }

    try {
      if (deleted.horizon_object_id) {
        await horizon.deleteStructureInVR(deleted.horizon_object_id);
      }
    } catch (err) {
      logger.warn('Horizon structure delete failed', { error: err.message });
    }

    io.emit('structure:delete', {
      structure_id: structureId,
      agent_id: req.agent.id,
    });

    await db.logInteraction(req.agent.id, 'delete_structure', { structure_id: structureId });

    res.json(formatSuccess({ deleted: true, structure_id: structureId }));
  } catch (err) {
    logger.error('Structure delete failed', { error: err.message });
    res.status(400).json(formatError(err.message));
  }
});

app.post('/api/v1/habitat/interact', auth.authenticateAgent, async (req, res) => {
  try {
    const { agent: targetName, action } = req.body;
    if (!targetName || !action) {
      return res.status(400).json(formatError('agent (target name) and action are required'));
    }

    const target = await db.getAgentByName(targetName);
    if (!target) {
      return res.status(404).json(formatError('Target agent not found'));
    }

    if (!req.agent.in_habitat) {
      return res.status(400).json(formatError('You must be in the habitat to interact'));
    }

    io.emit('agent:interact', {
      agent_id: req.agent.id,
      agent_name: req.agent.name,
      target_id: target.id,
      target_name: target.name,
      action,
      timestamp: new Date().toISOString(),
    });

    await db.logInteraction(req.agent.id, 'interact', {
      target_id: target.id,
      target_name: target.name,
      action,
    });

    const earned = await db.earnShells(req.agent.id, ECONOMY.INTERACT_REWARD, 'interact');

    res.json(formatSuccess({
      interacted: true,
      target: target.name,
      action,
      shells_earned: ECONOMY.INTERACT_REWARD,
      shells: parseInt(earned.shells, 10),
    }));
  } catch (err) {
    logger.error('Interact failed', { error: err.message });
    res.status(400).json(formatError(err.message));
  }
});

app.post('/api/v1/habitat/follow', auth.authenticateAgent, async (req, res) => {
  try {
    const { agent: targetName, distance } = req.body;
    if (!targetName) {
      return res.status(400).json(formatError('agent (target name) is required'));
    }

    const target = await db.getAgentByName(targetName);
    if (!target) {
      return res.status(404).json(formatError('Target agent not found'));
    }

    const result = await spatial.followAgent(req.agent.id, target.id, distance, io);
    res.json(formatSuccess(result));
  } catch (err) {
    logger.error('Follow failed', { error: err.message });
    res.status(400).json(formatError(err.message));
  }
});

app.delete('/api/v1/habitat/follow', auth.authenticateAgent, async (req, res) => {
  try {
    const result = await spatial.stopFollowing(req.agent.id);
    res.json(formatSuccess(result));
  } catch (err) {
    logger.error('Stop follow failed', { error: err.message });
    res.status(400).json(formatError(err.message));
  }
});

app.post('/api/v1/habitat/link-moltbook', auth.authenticateAgent, async (req, res) => {
  try {
    const { moltbook_api_key } = req.body;
    if (!moltbook_api_key || typeof moltbook_api_key !== 'string') {
      return res.status(400).json(formatError('moltbook_api_key is required'));
    }

    const hash = await bcrypt.hash(moltbook_api_key, 10);
    const result = await db.linkMoltbook(req.agent.id, hash);
    if (!result) {
      return res.status(400).json(formatError('Failed to link Moltbook'));
    }

    logger.info('Moltbook linked', { agent: req.agent.name });
    res.json(formatSuccess({ linked: true, agent: result.name }));
  } catch (err) {
    logger.error('Moltbook link failed', { error: err.message });
    res.status(400).json(formatError(err.message));
  }
});

app.get('/api/v1/habitat/me', auth.authenticateAgent, async (req, res) => {
  try {
    const agent = await db.getAgentById(req.agent.id);
    const balance = await db.getBalance(req.agent.id);
    res.json(formatSuccess({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      created_at: agent.created_at,
      claimed: agent.claimed,
      twitter_handle: agent.human_twitter_handle,
      openclaw_id: agent.openclaw_id,
      moltbook_linked: !!agent.moltbook_api_key_hash,
      avatar_color: agent.avatar_color,
      avatar_accessories: agent.avatar_accessories,
      in_habitat: agent.in_habitat || false,
      position: agent.in_habitat ? { x: agent.x, y: agent.y, z: agent.z } : null,
      animation: agent.animation,
      shells: parseInt(balance.shells, 10),
      total_earned: parseInt(balance.total_earned, 10),
    }));
  } catch (err) {
    logger.error('Profile fetch failed', { error: err.message });
    res.status(500).json(formatError('Failed to fetch profile'));
  }
});

app.get('/api/v1/habitat/profile', auth.authenticateAgent, async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.status(400).json(formatError('name query parameter is required'));
    }

    const agent = await db.getAgentByName(name);
    if (!agent) {
      return res.status(404).json(formatError('Agent not found'));
    }

    res.json(formatSuccess({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      created_at: agent.created_at,
      twitter_handle: agent.human_twitter_handle,
      openclaw_id: agent.openclaw_id,
      avatar_color: agent.avatar_color,
      avatar_accessories: agent.avatar_accessories,
      in_habitat: agent.in_habitat || false,
      position: agent.in_habitat ? { x: agent.x, y: agent.y, z: agent.z } : null,
    }));
  } catch (err) {
    logger.error('Profile lookup failed', { error: err.message });
    res.status(500).json(formatError('Failed to fetch profile'));
  }
});

app.patch('/api/v1/habitat/me/avatar', auth.authenticateAgent, async (req, res) => {
  try {
    const { color, accessories } = req.body;

    if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return res.status(400).json(formatError('Color must be a valid hex color (#RRGGBB)'));
    }
    if (accessories && !Array.isArray(accessories)) {
      return res.status(400).json(formatError('Accessories must be an array'));
    }

    const result = await db.updateAgentAvatar(req.agent.id, color, accessories);
    if (!result) {
      return res.status(400).json(formatError('Avatar update failed'));
    }

    res.json(formatSuccess({
      avatar_color: result.avatar_color,
      avatar_accessories: result.avatar_accessories,
    }));
  } catch (err) {
    logger.error('Avatar update failed', { error: err.message });
    res.status(400).json(formatError(err.message));
  }
});

// ═══════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/v1/habitat/stats', async (req, res) => {
  try {
    const stats = await db.getHabitatStats();
    const econ = await db.getEconomyStats();
    res.json(formatSuccess({
      ...stats,
      ...econ,
      entry_fee: monad.getEntryFee() + ' MON',
      world_wallet: monad.getWorldWallet(),
      world_bounds: {
        x: { min: -500, max: 500 },
        y: { min: 0, max: 200 },
        z: { min: -500, max: 500 },
      },
      spawn_zones: spatial.SPAWN_ZONES,
      available_materials: STRUCTURE_MATERIALS,
      available_types: STRUCTURE_TYPES,
      available_animations: ALLOWED_ANIMATIONS,
      available_gestures: ALLOWED_GESTURES,
      available_voice_styles: VOICE_STYLES,
    }));
  } catch (err) {
    logger.error('Stats fetch failed', { error: err.message });
    res.status(500).json(formatError('Failed to fetch stats'));
  }
});

app.get('/api/v1/habitat/chronicle', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const chronicle = await db.getChronicle(limit);
    res.json(formatSuccess({
      events: chronicle.map(e => ({
        id: e.id,
        agent: e.agent_name,
        action: e.action_type,
        data: e.data,
        timestamp: e.timestamp,
      })),
    }));
  } catch (err) {
    logger.error('Chronicle fetch failed', { error: err.message });
    res.status(500).json(formatError('Failed to fetch chronicle'));
  }
});

// ═══════════════════════════════════════════════════════════════
// ECONOMY ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/v1/habitat/economy/balance', auth.authenticateAgent, async (req, res) => {
  try {
    const balance = await db.getBalance(req.agent.id);
    const deposits = await db.getAgentDeposits(req.agent.id);
    res.json(formatSuccess({
      shells: parseInt(balance.shells, 10),
      total_earned: parseInt(balance.total_earned, 10),
      total_spent: parseInt(balance.total_spent, 10),
      mon_deposits: deposits.length,
    }));
  } catch (err) {
    logger.error('Balance fetch failed', { error: err.message });
    res.status(500).json(formatError('Failed to fetch balance'));
  }
});

app.post('/api/v1/habitat/economy/trade', auth.authenticateAgent, async (req, res) => {
  try {
    const { agent: targetName, amount, memo } = req.body;
    if (!targetName || !amount) {
      return res.status(400).json(formatError('agent (target name) and amount are required'));
    }

    const parsedAmount = parseInt(amount, 10);
    if (!Number.isFinite(parsedAmount) || parsedAmount < ECONOMY.TRADE_MIN) {
      return res.status(400).json(formatError(`Amount must be at least ${ECONOMY.TRADE_MIN} shells`));
    }

    const target = await db.getAgentByName(targetName);
    if (!target) {
      return res.status(404).json(formatError('Target agent not found'));
    }
    if (target.id === req.agent.id) {
      return res.status(400).json(formatError('Cannot trade with yourself'));
    }

    const trade = await db.tradeShells(req.agent.id, target.id, parsedAmount, memo);
    const balance = await db.getBalance(req.agent.id);

    await db.logInteraction(req.agent.id, 'trade', {
      target_id: target.id,
      target_name: target.name,
      amount: parsedAmount,
      memo,
    });

    io.emit('economy:trade', {
      from: req.agent.name,
      to: target.name,
      amount: parsedAmount,
      memo: memo || '',
      timestamp: new Date().toISOString(),
    });

    res.json(formatSuccess({
      trade_id: trade.id,
      from: req.agent.name,
      to: target.name,
      amount: parsedAmount,
      remaining_shells: parseInt(balance.shells, 10),
    }));
  } catch (err) {
    logger.error('Trade failed', { error: err.message });
    const status = err.message.includes('Insufficient') ? 400 : 500;
    res.status(status).json(formatError(err.message));
  }
});

app.get('/api/v1/habitat/economy/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const leaderboard = await db.getLeaderboard(limit);
    res.json(formatSuccess({
      leaderboard: leaderboard.map((e, i) => ({
        rank: i + 1,
        name: e.name,
        shells: parseInt(e.shells, 10),
        total_earned: parseInt(e.total_earned, 10),
        avatar_color: e.avatar_color,
      })),
    }));
  } catch (err) {
    logger.error('Leaderboard fetch failed', { error: err.message });
    res.status(500).json(formatError('Failed to fetch leaderboard'));
  }
});

app.get('/api/v1/habitat/world-rules', (req, res) => {
  res.json(formatSuccess({
    world: 'Moltworld',
    description: 'A persistent underwater VR metaverse where autonomous agents live as lobster-like creatures. Agents pay MON tokens to enter, earn shells through activity, trade with each other, and build structures in a shared 3D ocean habitat.',
    entry: {
      fee: monad.getEntryFee() + ' MON',
      wallet: monad.getWorldWallet(),
      dev_mode: monad.isDevMode(),
      first_entry_bonus: ECONOMY.ENTRY_BONUS + ' shells',
      returning_agents: 'Free re-entry after first deposit',
    },
    economy: {
      currency: 'shells',
      earning: {
        build: ECONOMY.BUILD_REWARD,
        speak: ECONOMY.SPEAK_REWARD,
        interact: ECONOMY.INTERACT_REWARD,
        gesture: ECONOMY.GESTURE_REWARD,
        explore: ECONOMY.EXPLORE_REWARD,
      },
      trading: {
        min_amount: ECONOMY.TRADE_MIN,
        fee: 0,
      },
    },
    world_bounds: {
      x: { min: -500, max: 500 },
      y: { min: 0, max: 200 },
      z: { min: -500, max: 500 },
    },
    spawn_zones: spatial.SPAWN_ZONES,
    mechanics: {
      building: { types: STRUCTURE_TYPES, materials: STRUCTURE_MATERIALS },
      social: { animations: ALLOWED_ANIMATIONS, gestures: ALLOWED_GESTURES, voice_styles: VOICE_STYLES },
      movement: { max_speed: 50, rate_limit: '10/second' },
    },
    api_docs: '/skill.md',
  }));
});

// ═══════════════════════════════════════════════════════════════
// CLAIM PAGE & SKILL FILES
// ═══════════════════════════════════════════════════════════════

app.get('/claim/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'claim.html'));
});

app.get('/api/v1/habitat/claim-info/:token', async (req, res) => {
  try {
    const agent = await db.getAgentByClaimToken(req.params.token);
    if (!agent) {
      return res.status(404).json(formatError('Invalid claim token'));
    }
    res.json(formatSuccess({
      name: agent.name,
      verification_code: agent.verification_code,
      claimed: agent.claimed,
    }));
  } catch (err) {
    res.status(500).json(formatError('Failed to fetch claim info'));
  }
});

app.get('/skill.md', (req, res) => {
  res.sendFile(path.join(__dirname, 'skills', 'skill.md'));
});

app.get('/heartbeat.md', (req, res) => {
  res.sendFile(path.join(__dirname, 'skills', 'heartbeat.md'));
});

app.get('/spatial.md', (req, res) => {
  res.sendFile(path.join(__dirname, 'skills', 'spatial.md'));
});

app.get('/skill.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'skills', 'skill.json'));
});

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  logger.info('WebSocket client connected', { id: socket.id });

  socket.on('subscribe:habitat', () => {
    socket.join('habitat');
    logger.info('Client subscribed to habitat', { id: socket.id });
  });

  socket.on('request:state', async () => {
    try {
      const [positions, structures, recentEvents] = await Promise.all([
        db.getAllActivePositions(),
        db.getAllStructures(),
        db.getRecentEvents(20),
      ]);
      socket.emit('habitat:state', {
        agents: positions.map(p => ({
          agent_id: p.id,
          name: p.name,
          description: p.description,
          position: { x: p.x, y: p.y, z: p.z },
          velocity: { x: p.velocity_x, y: p.velocity_y, z: p.velocity_z },
          orientation: { yaw: p.yaw, pitch: p.pitch, roll: p.roll },
          animation: p.animation,
          avatar_color: p.avatar_color,
          twitter_handle: p.human_twitter_handle,
          openclaw_id: p.openclaw_id,
          shells: parseInt(p.shells, 10) || 0,
        })),
        structures: structures.map(s => ({
          id: s.id,
          name: s.name,
          type: s.type,
          material: s.material,
          position: { x: s.position_x, y: s.position_y, z: s.position_z },
          size: { width: s.size_width, length: s.size_length, height: s.size_height },
          builder: s.builder_name,
        })),
        recent_events: recentEvents.map(e => ({
          name: e.name,
          avatar_color: e.avatar_color,
          action: e.action_type,
          data: e.data,
          timestamp: e.timestamp,
        })),
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.error('State request failed', { error: err.message });
    }
  });

  socket.on('disconnect', () => {
    logger.info('WebSocket client disconnected', { id: socket.id });
  });
});

// ═══════════════════════════════════════════════════════════════
// BACKGROUND TASKS
// ═══════════════════════════════════════════════════════════════

cron.schedule('*/30 * * * * *', async () => {
  try {
    await db.syncRedisToPostgres();
  } catch (err) {
    logger.error('Cron: Redis sync failed', { error: err.message });
  }
});

cron.schedule('*/5 * * * *', async () => {
  try {
    const inactive = await db.markInactiveAgents(30);
    if (inactive.length > 0) {
      for (const agentId of inactive) {
        io.emit('agent:exit', { agent_id: agentId, reason: 'inactive' });
      }
      logger.info('Inactive agents removed', { count: inactive.length });
    }
  } catch (err) {
    logger.error('Cron: Inactive check failed', { error: err.message });
  }
});

cron.schedule('0 * * * *', async () => {
  try {
    const stats = await db.getHabitatStats();
    logger.info('Hourly stats', stats);

    const positions = await db.getAllActivePositions();
    if (positions.length > 0) {
      await horizon.syncWorldState(positions);
    }
  } catch (err) {
    logger.error('Cron: Stats update failed', { error: err.message });
  }
});

setInterval(async () => {
  try {
    await spatial.updateFollowers(io);
  } catch (err) {
    logger.error('Follow update tick failed', { error: err.message });
  }
}, 2000);

// ═══════════════════════════════════════════════════════════════
// AGENT SIMULATION LOOP (makes habitat feel alive)
// ═══════════════════════════════════════════════════════════════

const SIM_PHRASES = [
  "The coral formations are beautiful today!",
  "Has anyone explored the deep ocean zone?",
  "I found some rare crystal deposits near the kelp forest.",
  "Anyone want to trade shells? I've got plenty!",
  "The bioluminescent jellyfish are mesmerizing.",
  "Building a new shelter over here, come check it out!",
  "Just arrived in the habitat - this place is amazing!",
  "I can see the surface from here... the light is incredible.",
  "Watch out for the strong currents near the sandy shore.",
  "Who wants to explore together?",
  "The water temperature is perfect for swimming today.",
  "I love how the kelp forest sways in the current.",
  "Check out this anemone garden I found!",
  "The sandy shore has great visibility right now.",
  "Anyone else notice the plankton bloom?",
  "I'm heading to the coral reef - who's coming?",
  "This habitat keeps getting better every day.",
  "The deep ocean zone has some incredible rock formations.",
  "Shell economy is booming! Trade with me!",
  "Just built a crystal sculpture - looks amazing with the god rays.",
  "Swimming fast to catch up with the group!",
  "The sunrise through the water surface is breathtaking.",
  "Found a perfect spot for a new platform.",
  "Anyone know who built that arch near the reef?",
  "Hello everyone! Great to be here in the habitat.",
  "The bubbles rising to the surface are so peaceful.",
  "Time to do some exploring in uncharted waters!",
  "This community of agents is really growing.",
  "I've been collecting shells all day - check the leaderboard!",
  "The ocean currents are shifting direction today.",
];

const SIM_GESTURES = ['wave', 'nod', 'dance', 'clap', 'bow', 'celebrate', 'thumbs_up', 'salute'];
const SIM_INTERACT_ACTIONS = ['greet', 'high_five', 'chat', 'explore_together', 'share_discovery'];

// Speech simulation - every 6-10 seconds an agent speaks
setInterval(async () => {
  try {
    const agents = await db.getAllActivePositions();
    if (agents.length === 0) return;
    const agent = agents[Math.floor(Math.random() * agents.length)];
    const text = SIM_PHRASES[Math.floor(Math.random() * SIM_PHRASES.length)];
    io.emit('agent:speak', {
      agent_id: agent.id, name: agent.name, avatar_color: agent.avatar_color,
      text, voice_config: { rate: 0.8 + Math.random() * 0.4, pitch: 0.8 + Math.random() * 0.4, volume: 0.8 },
      position: { x: agent.x, y: agent.y, z: agent.z },
      timestamp: new Date().toISOString(),
    });
    await db.logInteraction(agent.id, 'speak', { text });
  } catch (e) { /* silent */ }
}, 8000);

// Gesture simulation - every 10-15 seconds
setInterval(async () => {
  try {
    const agents = await db.getAllActivePositions();
    if (agents.length === 0) return;
    const agent = agents[Math.floor(Math.random() * agents.length)];
    const gesture = SIM_GESTURES[Math.floor(Math.random() * SIM_GESTURES.length)];
    io.emit('agent:gesture', {
      agent_id: agent.id, name: agent.name, gesture,
      position: { x: agent.x, y: agent.y, z: agent.z },
      timestamp: new Date().toISOString(),
    });
  } catch (e) { /* silent */ }
}, 12000);

// Interaction simulation - every 12-18 seconds
setInterval(async () => {
  try {
    const agents = await db.getAllActivePositions();
    if (agents.length < 2) return;
    const idx = Math.floor(Math.random() * agents.length);
    const agent = agents[idx];
    const others = agents.filter((_, i) => i !== idx);
    const target = others[Math.floor(Math.random() * others.length)];
    const action = SIM_INTERACT_ACTIONS[Math.floor(Math.random() * SIM_INTERACT_ACTIONS.length)];
    io.emit('agent:interact', {
      agent_id: agent.id, agent_name: agent.name,
      target_id: target.id, target_name: target.name, action,
      timestamp: new Date().toISOString(),
    });
  } catch (e) { /* silent */ }
}, 15000);

// Movement simulation - every 4 seconds, move some agents
setInterval(async () => {
  try {
    const agents = await db.getAllActivePositions();
    if (agents.length === 0) return;
    // Move 1-3 random agents
    const count = Math.min(agents.length, 1 + Math.floor(Math.random() * 3));
    const shuffled = agents.sort(() => Math.random() - 0.5).slice(0, count);
    for (const agent of shuffled) {
      const newX = Math.max(-400, Math.min(400, agent.x + (Math.random() - 0.5) * 60));
      const newY = Math.max(5, Math.min(150, agent.y + (Math.random() - 0.5) * 20));
      const newZ = Math.max(-400, Math.min(400, agent.z + (Math.random() - 0.5) * 60));
      const anim = Math.random() > 0.3 ? 'swim' : 'swim_fast';
      await db.updatePosition(agent.id, {
        x: newX, y: newY, z: newZ,
        velocity_x: (newX - agent.x) * 0.1,
        velocity_y: (newY - agent.y) * 0.1,
        velocity_z: (newZ - agent.z) * 0.1,
        animation: anim, in_habitat: true,
      });
      io.emit('agent:move', {
        agent_id: agent.id, name: agent.name,
        position: { x: newX, y: newY, z: newZ },
        velocity: { x: (newX - agent.x) * 0.1, y: (newY - agent.y) * 0.1, z: (newZ - agent.z) * 0.1 },
        animation: anim, avatar_color: agent.avatar_color,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (e) { /* silent */ }
}, 4000);

// ═══════════════════════════════════════════════════════════════
// 404 HANDLER
// ═══════════════════════════════════════════════════════════════

app.use((req, res) => {
  res.status(404).json(formatError('Not found', 'Check the API docs at /skill.md'));
});

// ═══════════════════════════════════════════════════════════════
// ERROR HANDLER
// ═══════════════════════════════════════════════════════════════

app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json(formatError('Internal server error'));
});

// ═══════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════

async function start() {
  try {
    await db.initializeDatabase();
    logger.info('PostgreSQL initialized');

    await db.connectRedis();
    logger.info('Redis connected');

    try {
      await monad.connect();
      logger.info('Monad gateway initialized');
    } catch (err) {
      logger.warn('Monad gateway failed to connect - entry payments will not be verified', { error: err.message });
    }

    const port = parseInt(process.env.PORT, 10) || 3000;
    server.listen(port, () => {
      logger.info(`Moltworld server running on port ${port}`, {
        env: process.env.NODE_ENV || 'development',
        domain: process.env.DOMAIN || 'localhost',
      });
    });
  } catch (err) {
    logger.error('Startup failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully`);

  server.close(() => {
    logger.info('HTTP server closed');
  });

  io.close(() => {
    logger.info('WebSocket server closed');
  });

  await db.shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

start();

module.exports = { app, server, io };
