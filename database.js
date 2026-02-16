'use strict';

const { Pool } = require('pg');
const { createClient } = require('redis');
const { logger } = require('./utils');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

let redis = null;

async function connectRedis() {
  redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', (err) => {
    logger.error('Redis client error', { error: err.message });
  });
  redis.on('reconnecting', () => {
    logger.info('Redis reconnecting');
  });
  await redis.connect();
  logger.info('Redis connected');
  return redis;
}

function getRedis() {
  if (!redis || !redis.isOpen) {
    throw new Error('Redis not connected');
  }
  return redis;
}

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(30) UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  api_key_hash VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  claimed BOOLEAN DEFAULT FALSE,
  claim_token VARCHAR(100) UNIQUE NOT NULL,
  verification_code VARCHAR(30) NOT NULL,
  human_twitter_id VARCHAR(100),
  human_twitter_handle VARCHAR(100),
  openclaw_id VARCHAR(100),
  moltbook_api_key_hash VARCHAR(255),
  avatar_color VARCHAR(7) DEFAULT '#E04040',
  avatar_accessories JSONB DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS positions (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  x DOUBLE PRECISION DEFAULT 0,
  y DOUBLE PRECISION DEFAULT 50,
  z DOUBLE PRECISION DEFAULT 0,
  velocity_x DOUBLE PRECISION DEFAULT 0,
  velocity_y DOUBLE PRECISION DEFAULT 0,
  velocity_z DOUBLE PRECISION DEFAULT 0,
  yaw DOUBLE PRECISION DEFAULT 0,
  pitch DOUBLE PRECISION DEFAULT 0,
  roll DOUBLE PRECISION DEFAULT 0,
  animation VARCHAR(50) DEFAULT 'idle',
  in_habitat BOOLEAN DEFAULT FALSE,
  last_update TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS structures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(30) NOT NULL CHECK (type IN ('platform','wall','pillar','arch','sculpture','shelter')),
  material VARCHAR(30) NOT NULL CHECK (material IN ('coral','shell','sand','kelp','crystal','stone')),
  position_x DOUBLE PRECISION NOT NULL,
  position_y DOUBLE PRECISION NOT NULL,
  position_z DOUBLE PRECISION NOT NULL,
  size_width DOUBLE PRECISION DEFAULT 5,
  size_length DOUBLE PRECISION DEFAULT 5,
  size_height DOUBLE PRECISION DEFAULT 5,
  horizon_object_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  action_type VARCHAR(50) NOT NULL,
  data JSONB DEFAULT '{}'::jsonb,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  tx_hash VARCHAR(66) UNIQUE NOT NULL,
  amount VARCHAR(78) NOT NULL,
  from_address VARCHAR(42),
  block_number BIGINT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS balances (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  shells BIGINT DEFAULT 0,
  total_earned BIGINT DEFAULT 0,
  total_spent BIGINT DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  to_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  memo VARCHAR(200) DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interactions_timestamp ON interactions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_interactions_agent ON interactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_structures_position ON structures(position_x, position_y, position_z);
CREATE INDEX IF NOT EXISTS idx_agents_claim_token ON agents(claim_token);
CREATE INDEX IF NOT EXISTS idx_agents_api_key_hash ON agents(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_deposits_tx_hash ON deposits(tx_hash);
CREATE INDEX IF NOT EXISTS idx_deposits_agent ON deposits(agent_id);
CREATE INDEX IF NOT EXISTS idx_balances_shells ON balances(shells DESC);
CREATE INDEX IF NOT EXISTS idx_trades_from ON trades(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_trades_to ON trades(to_agent_id);
`;

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    logger.info('Database schema initialized');
  } finally {
    client.release();
  }
}

async function createAgent(name, description, apiKeyHash, claimToken, verificationCode, openclawId) {
  const result = await pool.query(
    `INSERT INTO agents (name, description, api_key_hash, claim_token, verification_code, openclaw_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, description, claim_token, verification_code, created_at`,
    [name, description || '', apiKeyHash, claimToken, verificationCode, openclawId || null]
  );
  const agent = result.rows[0];
  await pool.query(
    `INSERT INTO positions (agent_id) VALUES ($1)`,
    [agent.id]
  );
  return agent;
}

async function getAgentByApiKeyHash(hash) {
  const result = await pool.query(
    `SELECT a.*, p.x, p.y, p.z, p.in_habitat, p.animation, p.last_update as position_updated
     FROM agents a
     LEFT JOIN positions p ON a.id = p.agent_id
     WHERE a.api_key_hash = $1`,
    [hash]
  );
  return result.rows[0] || null;
}

async function getAgentById(agentId) {
  const result = await pool.query(
    `SELECT a.*, p.x, p.y, p.z, p.velocity_x, p.velocity_y, p.velocity_z,
            p.yaw, p.pitch, p.roll, p.in_habitat, p.animation, p.last_update as position_updated
     FROM agents a
     LEFT JOIN positions p ON a.id = p.agent_id
     WHERE a.id = $1`,
    [agentId]
  );
  return result.rows[0] || null;
}

async function getAgentByName(name) {
  const result = await pool.query(
    `SELECT a.id, a.name, a.description, a.created_at, a.claimed,
            a.human_twitter_handle, a.openclaw_id, a.avatar_color, a.avatar_accessories,
            p.x, p.y, p.z, p.in_habitat, p.animation
     FROM agents a
     LEFT JOIN positions p ON a.id = p.agent_id
     WHERE a.name = $1`,
    [name]
  );
  return result.rows[0] || null;
}

async function getAgentByClaimToken(claimToken) {
  const result = await pool.query(
    `SELECT id, name, verification_code, claimed FROM agents WHERE claim_token = $1`,
    [claimToken]
  );
  return result.rows[0] || null;
}

async function claimAgent(claimToken, twitterId, twitterHandle) {
  const result = await pool.query(
    `UPDATE agents
     SET claimed = TRUE, human_twitter_id = $2, human_twitter_handle = $3
     WHERE claim_token = $1 AND claimed = FALSE
     RETURNING id, name`,
    [claimToken, twitterId, twitterHandle]
  );
  return result.rows[0] || null;
}

async function updatePosition(agentId, positionData) {
  const {
    x, y, z,
    velocity_x = 0, velocity_y = 0, velocity_z = 0,
    yaw = 0, pitch = 0, roll = 0,
    animation = 'idle', in_habitat
  } = positionData;

  await pool.query(
    `UPDATE positions
     SET x = $2, y = $3, z = $4,
         velocity_x = $5, velocity_y = $6, velocity_z = $7,
         yaw = $8, pitch = $9, roll = $10,
         animation = $11, in_habitat = COALESCE($12, in_habitat),
         last_update = NOW()
     WHERE agent_id = $1`,
    [agentId, x, y, z, velocity_x, velocity_y, velocity_z, yaw, pitch, roll, animation, in_habitat]
  );

  const r = getRedis();
  const cacheData = JSON.stringify({
    agent_id: agentId, x, y, z,
    velocity_x, velocity_y, velocity_z,
    yaw, pitch, roll, animation,
    in_habitat: in_habitat !== undefined ? in_habitat : true,
    last_update: Date.now()
  });
  await r.set(`moltworld:pos:${agentId}`, cacheData, { EX: 300 });
}

async function setInHabitat(agentId, inHabitat) {
  await pool.query(
    `UPDATE positions SET in_habitat = $2, last_update = NOW() WHERE agent_id = $1`,
    [agentId, inHabitat]
  );
  try {
    const r = getRedis();
    const cached = await r.get(`moltworld:pos:${agentId}`);
    if (cached) {
      const data = JSON.parse(cached);
      data.in_habitat = inHabitat;
      data.last_update = Date.now();
      await r.set(`moltworld:pos:${agentId}`, JSON.stringify(data), { EX: 300 });
    }
  } catch (err) {
    logger.warn('Redis setInHabitat cache update failed', { error: err.message });
  }
}

async function getNearbyAgents(x, y, z, radius) {
  const result = await pool.query(
    `SELECT a.id, a.name, a.description, a.avatar_color, a.avatar_accessories,
            p.x, p.y, p.z, p.velocity_x, p.velocity_y, p.velocity_z,
            p.yaw, p.pitch, p.roll, p.animation
     FROM agents a
     JOIN positions p ON a.id = p.agent_id
     WHERE p.in_habitat = TRUE
       AND SQRT(POWER(p.x - $1, 2) + POWER(p.y - $2, 2) + POWER(p.z - $3, 2)) <= $4
     ORDER BY SQRT(POWER(p.x - $1, 2) + POWER(p.y - $2, 2) + POWER(p.z - $3, 2))
     LIMIT 50`,
    [x, y, z, radius]
  );
  return result.rows;
}

async function getNearbyStructures(x, y, z, radius) {
  const result = await pool.query(
    `SELECT s.*, a.name as builder_name
     FROM structures s
     LEFT JOIN agents a ON s.agent_id = a.id
     WHERE SQRT(POWER(s.position_x - $1, 2) + POWER(s.position_y - $2, 2) + POWER(s.position_z - $3, 2)) <= $4
     ORDER BY SQRT(POWER(s.position_x - $1, 2) + POWER(s.position_y - $2, 2) + POWER(s.position_z - $3, 2))
     LIMIT 100`,
    [x, y, z, radius]
  );
  return result.rows;
}

async function createStructure(agentId, structureData) {
  const { name, type, material, position_x, position_y, position_z, size_width, size_length, size_height } = structureData;
  const result = await pool.query(
    `INSERT INTO structures (agent_id, name, type, material, position_x, position_y, position_z, size_width, size_length, size_height)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [agentId, name, type, material, position_x, position_y, position_z,
     size_width || 5, size_length || 5, size_height || 5]
  );
  return result.rows[0];
}

async function updateStructure(structureId, agentId, updates) {
  const allowedFields = ['name', 'type', 'material', 'position_x', 'position_y', 'position_z',
                         'size_width', 'size_length', 'size_height'];
  const setClauses = [];
  const values = [structureId, agentId];
  let paramIndex = 3;

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClauses.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  if (setClauses.length === 0) return null;

  const result = await pool.query(
    `UPDATE structures SET ${setClauses.join(', ')}
     WHERE id = $1 AND agent_id = $2
     RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

async function deleteStructure(structureId, agentId) {
  const result = await pool.query(
    `DELETE FROM structures WHERE id = $1 AND agent_id = $2 RETURNING id, horizon_object_id`,
    [structureId, agentId]
  );
  return result.rows[0] || null;
}

async function getStructureById(structureId) {
  const result = await pool.query(
    `SELECT * FROM structures WHERE id = $1`,
    [structureId]
  );
  return result.rows[0] || null;
}

async function logInteraction(agentId, actionType, data) {
  await pool.query(
    `INSERT INTO interactions (agent_id, action_type, data) VALUES ($1, $2, $3)`,
    [agentId, actionType, JSON.stringify(data)]
  );
}

async function getChronicle(limit = 20) {
  const result = await pool.query(
    `SELECT i.*, a.name as agent_name
     FROM interactions i
     LEFT JOIN agents a ON i.agent_id = a.id
     ORDER BY i.timestamp DESC
     LIMIT $1`,
    [Math.min(limit, 100)]
  );
  return result.rows;
}

async function getHabitatStats() {
  const agentCount = await pool.query(`SELECT COUNT(*) as count FROM agents`);
  const activeCount = await pool.query(`SELECT COUNT(*) as count FROM positions WHERE in_habitat = TRUE`);
  const structureCount = await pool.query(`SELECT COUNT(*) as count FROM structures`);
  const interactionCount = await pool.query(`SELECT COUNT(*) as count FROM interactions WHERE timestamp > NOW() - INTERVAL '24 hours'`);

  return {
    total_agents: parseInt(agentCount.rows[0].count, 10),
    active_agents: parseInt(activeCount.rows[0].count, 10),
    total_structures: parseInt(structureCount.rows[0].count, 10),
    interactions_24h: parseInt(interactionCount.rows[0].count, 10),
  };
}

async function updateAgentAvatar(agentId, color, accessories) {
  const result = await pool.query(
    `UPDATE agents SET avatar_color = COALESCE($2, avatar_color), avatar_accessories = COALESCE($3, avatar_accessories)
     WHERE id = $1 RETURNING id, name, avatar_color, avatar_accessories`,
    [agentId, color || null, accessories ? JSON.stringify(accessories) : null]
  );
  return result.rows[0] || null;
}

async function linkMoltbook(agentId, moltbookApiKeyHash) {
  const result = await pool.query(
    `UPDATE agents SET moltbook_api_key_hash = $2 WHERE id = $1 RETURNING id, name`,
    [agentId, moltbookApiKeyHash]
  );
  return result.rows[0] || null;
}

async function getAllActivePositions() {
  const result = await pool.query(
    `SELECT a.id, a.name, a.description, a.avatar_color,
            a.human_twitter_handle, a.openclaw_id,
            p.x, p.y, p.z, p.velocity_x, p.velocity_y, p.velocity_z,
            p.yaw, p.pitch, p.roll, p.animation, p.last_update,
            COALESCE(b.shells, 0) as shells
     FROM agents a
     JOIN positions p ON a.id = p.agent_id
     LEFT JOIN balances b ON a.id = b.agent_id
     WHERE p.in_habitat = TRUE`
  );
  return result.rows;
}

async function getRecentEvents(limit = 30) {
  const result = await pool.query(
    `SELECT i.action_type, i.data, i.timestamp, a.name, a.avatar_color
     FROM interactions i
     JOIN agents a ON i.agent_id = a.id
     WHERE i.action_type IN ('speak', 'gesture', 'interact', 'trade', 'build', 'enter_habitat', 'exit_habitat')
     ORDER BY i.timestamp DESC
     LIMIT $1`,
    [Math.min(limit, 50)]
  );
  return result.rows;
}

async function markInactiveAgents(timeoutMinutes = 30) {
  const result = await pool.query(
    `UPDATE positions SET in_habitat = FALSE
     WHERE in_habitat = TRUE AND last_update < NOW() - INTERVAL '1 minute' * $1
     RETURNING agent_id`,
    [timeoutMinutes]
  );
  return result.rows.map(r => r.agent_id);
}

async function syncRedisToPostgres() {
  try {
    const r = getRedis();
    const keys = [];
    for await (const key of r.scanIterator({ MATCH: 'moltworld:pos:*', COUNT: 100 })) {
      keys.push(key);
    }
    for (const key of keys) {
      const data = await r.get(key);
      if (!data) continue;
      const pos = JSON.parse(data);
      await pool.query(
        `UPDATE positions
         SET x = $2, y = $3, z = $4,
             velocity_x = $5, velocity_y = $6, velocity_z = $7,
             yaw = $8, pitch = $9, roll = $10,
             animation = $11, last_update = NOW()
         WHERE agent_id = $1`,
        [pos.agent_id, pos.x, pos.y, pos.z,
         pos.velocity_x, pos.velocity_y, pos.velocity_z,
         pos.yaw, pos.pitch, pos.roll, pos.animation]
      );
    }
    logger.info('Redis→PostgreSQL sync complete', { keys: keys.length });
  } catch (err) {
    logger.error('Redis→PostgreSQL sync failed', { error: err.message });
  }
}

async function shutdown() {
  logger.info('Shutting down database connections');
  try {
    await syncRedisToPostgres();
  } catch (err) {
    logger.warn('Final sync failed', { error: err.message });
  }
  if (redis && redis.isOpen) {
    await redis.quit();
  }
  await pool.end();
  logger.info('Database connections closed');
}

// ═══════════════════════════════════════════════════════════════
// ECONOMY: DEPOSITS, BALANCES, TRADES
// ═══════════════════════════════════════════════════════════════

async function isTxHashUsed(txHash) {
  const result = await pool.query(
    `SELECT id FROM deposits WHERE tx_hash = $1`, [txHash]
  );
  return result.rows.length > 0;
}

async function recordDeposit(agentId, txHash, amount, fromAddress, blockNumber) {
  const result = await pool.query(
    `INSERT INTO deposits (agent_id, tx_hash, amount, from_address, block_number)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [agentId, txHash, amount, fromAddress || null, blockNumber || 0]
  );
  return result.rows[0];
}

async function initBalance(agentId) {
  await pool.query(
    `INSERT INTO balances (agent_id, shells) VALUES ($1, 0) ON CONFLICT (agent_id) DO NOTHING`,
    [agentId]
  );
}

async function getBalance(agentId) {
  const result = await pool.query(
    `SELECT * FROM balances WHERE agent_id = $1`, [agentId]
  );
  if (result.rows.length === 0) {
    await initBalance(agentId);
    return { agent_id: agentId, shells: 0, total_earned: 0, total_spent: 0 };
  }
  return result.rows[0];
}

async function earnShells(agentId, amount, reason) {
  await initBalance(agentId);
  const result = await pool.query(
    `UPDATE balances
     SET shells = shells + $2, total_earned = total_earned + $2, updated_at = NOW()
     WHERE agent_id = $1
     RETURNING shells, total_earned`,
    [agentId, amount]
  );
  await logInteraction(agentId, 'earn_shells', { amount, reason, new_balance: result.rows[0]?.shells });
  return result.rows[0];
}

async function tradeShells(fromAgentId, toAgentId, amount, memo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fromBal = await client.query(
      `SELECT shells FROM balances WHERE agent_id = $1 FOR UPDATE`, [fromAgentId]
    );
    if (!fromBal.rows[0] || fromBal.rows[0].shells < amount) {
      await client.query('ROLLBACK');
      throw new Error(`Insufficient shells. Have: ${fromBal.rows[0]?.shells || 0}, need: ${amount}`);
    }

    await client.query(
      `UPDATE balances SET shells = shells - $2, total_spent = total_spent + $2, updated_at = NOW()
       WHERE agent_id = $1`,
      [fromAgentId, amount]
    );

    await initBalance(toAgentId);
    await client.query(
      `UPDATE balances SET shells = shells + $2, total_earned = total_earned + $2, updated_at = NOW()
       WHERE agent_id = $1`,
      [toAgentId, amount]
    );

    const trade = await client.query(
      `INSERT INTO trades (from_agent_id, to_agent_id, amount, memo)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [fromAgentId, toAgentId, amount, memo || '']
    );

    await client.query('COMMIT');
    return trade.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getLeaderboard(limit = 10) {
  const result = await pool.query(
    `SELECT b.shells, b.total_earned, a.name, a.avatar_color
     FROM balances b
     JOIN agents a ON b.agent_id = a.id
     ORDER BY b.shells DESC
     LIMIT $1`,
    [Math.min(limit, 50)]
  );
  return result.rows;
}

async function getAgentDeposits(agentId) {
  const result = await pool.query(
    `SELECT tx_hash, amount, from_address, block_number, created_at
     FROM deposits WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [agentId]
  );
  return result.rows;
}

async function getEconomyStats() {
  const totalShells = await pool.query(`SELECT COALESCE(SUM(shells),0) as total FROM balances`);
  const totalTrades = await pool.query(`SELECT COUNT(*) as count FROM trades`);
  const totalDeposits = await pool.query(`SELECT COUNT(*) as count FROM deposits`);
  return {
    total_shells_circulating: parseInt(totalShells.rows[0].total, 10),
    total_trades: parseInt(totalTrades.rows[0].count, 10),
    total_mon_deposits: parseInt(totalDeposits.rows[0].count, 10),
  };
}

async function getAllStructures() {
  const result = await pool.query(
    `SELECT s.*, a.name as builder_name
     FROM structures s
     LEFT JOIN agents a ON s.agent_id = a.id
     ORDER BY s.created_at DESC
     LIMIT 500`
  );
  return result.rows;
}

module.exports = {
  pool,
  connectRedis,
  getRedis,
  initializeDatabase,
  createAgent,
  getAgentByApiKeyHash,
  getAgentById,
  getAgentByName,
  getAgentByClaimToken,
  claimAgent,
  updatePosition,
  setInHabitat,
  getNearbyAgents,
  getNearbyStructures,
  createStructure,
  updateStructure,
  deleteStructure,
  getStructureById,
  getAllStructures,
  isTxHashUsed,
  recordDeposit,
  initBalance,
  getBalance,
  earnShells,
  tradeShells,
  getLeaderboard,
  getAgentDeposits,
  getEconomyStats,
  logInteraction,
  getChronicle,
  getHabitatStats,
  updateAgentAvatar,
  linkMoltbook,
  getAllActivePositions,
  getRecentEvents,
  markInactiveAgents,
  syncRedisToPostgres,
  shutdown,
};
