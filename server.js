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
const {
  logger, formatError, formatSuccess, validatePosition, validateName,
  validateStructureType, validateMaterial, validateAnimation, validateGesture,
  validateVoiceStyle, apiLimiter, movementLimiter, speechLimiter, buildLimiter,
  registrationLimiter, claimLimiter, STRUCTURE_TYPES, STRUCTURE_MATERIALS,
  VOICE_STYLES, ALLOWED_ANIMATIONS, ALLOWED_GESTURES,
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
    const { preferred_spawn } = req.body;
    const result = await spatial.enterHabitat(req.agent.id, preferred_spawn, io);
    res.json(formatSuccess(result));
  } catch (err) {
    logger.error('Enter habitat failed', { error: err.message, agent: req.agent.name });
    res.status(400).json(formatError(err.message));
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
    res.json(formatSuccess(result));
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

    res.json(formatSuccess({ gesture, performed: true }));
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

    res.status(201).json(formatSuccess({
      structure_id: structure.id,
      structure,
      horizon_synced: !!horizonResult?.synced,
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

    res.json(formatSuccess({
      interacted: true,
      target: target.name,
      action,
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
    res.json(formatSuccess({
      ...stats,
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
      const positions = await db.getAllActivePositions();
      const structures = await db.getAllStructures();
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
