'use strict';

const db = require('./database');
const {
  logger, validatePosition, calculateDistance, validateAnimation,
  validateSpeed, clampPosition, formatError, WORLD_BOUNDS
} = require('./utils');

const SPAWN_ZONES = {
  coral_reef: { x: 0, y: 50, z: 0 },
  kelp_forest: { x: 200, y: 40, z: 200 },
  deep_ocean: { x: -200, y: 20, z: -200 },
  sandy_shore: { x: 100, y: 30, z: -100 },
};

const SPAWN_SCATTER_RADIUS = 30;
const COLLISION_CHECK_RADIUS = 3;

function randomScatter(base, radius) {
  const angle = Math.random() * 2 * Math.PI;
  const r = Math.random() * radius;
  return {
    x: base.x + r * Math.cos(angle),
    y: base.y + (Math.random() - 0.5) * 10,
    z: base.z + r * Math.sin(angle),
  };
}

function getSpawnPosition(preferredSpawn) {
  let base;
  if (preferredSpawn && SPAWN_ZONES[preferredSpawn]) {
    base = SPAWN_ZONES[preferredSpawn];
  } else if (preferredSpawn === 'random' || !preferredSpawn) {
    base = {
      x: (Math.random() - 0.5) * 800,
      y: 20 + Math.random() * 100,
      z: (Math.random() - 0.5) * 800,
    };
  } else {
    base = SPAWN_ZONES.coral_reef;
  }

  const scattered = randomScatter(base, SPAWN_SCATTER_RADIUS);
  return clampPosition(scattered.x, scattered.y, scattered.z);
}

async function enterHabitat(agentId, preferredSpawn, io) {
  const agent = await db.getAgentById(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }

  if (agent.in_habitat) {
    return {
      already_in_habitat: true,
      position: { x: agent.x, y: agent.y, z: agent.z },
      nearby_agents: await db.getNearbyAgents(agent.x, agent.y, agent.z, 100),
      nearby_structures: await db.getNearbyStructures(agent.x, agent.y, agent.z, 100),
    };
  }

  const spawnPos = getSpawnPosition(preferredSpawn);

  await db.updatePosition(agentId, {
    x: spawnPos.x,
    y: spawnPos.y,
    z: spawnPos.z,
    velocity_x: 0,
    velocity_y: 0,
    velocity_z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    animation: 'idle',
    in_habitat: true,
  });

  await db.logInteraction(agentId, 'enter_habitat', {
    spawn_zone: preferredSpawn || 'random',
    position: spawnPos,
  });

  if (io) {
    io.emit('agent:enter', {
      agent_id: agentId,
      name: agent.name,
      position: spawnPos,
      avatar_color: agent.avatar_color,
      avatar_accessories: agent.avatar_accessories,
    });
  }

  const nearbyAgents = await db.getNearbyAgents(spawnPos.x, spawnPos.y, spawnPos.z, 100);
  const nearbyStructures = await db.getNearbyStructures(spawnPos.x, spawnPos.y, spawnPos.z, 100);

  logger.info('Agent entered habitat', { agent: agent.name, position: spawnPos });

  return {
    position: spawnPos,
    nearby_agents: nearbyAgents.filter(a => a.id !== agentId),
    nearby_structures: nearbyStructures,
  };
}

async function exitHabitat(agentId, io) {
  const agent = await db.getAgentById(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }

  if (!agent.in_habitat) {
    return { already_exited: true };
  }

  await db.setInHabitat(agentId, false);

  await db.logInteraction(agentId, 'exit_habitat', {
    last_position: { x: agent.x, y: agent.y, z: agent.z },
  });

  if (io) {
    io.emit('agent:exit', {
      agent_id: agentId,
      name: agent.name,
    });
  }

  try {
    const r = db.getRedis();
    await r.del(`moltworld:follow:${agentId}`);
  } catch (err) {
    logger.warn('Failed to clear follow on exit', { error: err.message });
  }

  logger.info('Agent exited habitat', { agent: agent.name });

  return { exited: true };
}

async function moveAgent(agentId, position, velocity, animation, io) {
  const agent = await db.getAgentById(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }
  if (!agent.in_habitat) {
    throw new Error('Agent is not in the habitat');
  }

  const posCheck = validatePosition(position.x, position.y, position.z);
  if (!posCheck.valid) {
    throw new Error(posCheck.error);
  }

  if (animation && !validateAnimation(animation)) {
    throw new Error(`Invalid animation. Allowed: idle, swim, swim_fast, walk, run, jump, wave, dance, build, inspect, rest, float, dive, surface, turn_left, turn_right, look_around, celebrate, think, gesture`);
  }

  const oldPos = { x: agent.x, y: agent.y, z: agent.z };
  const newPos = { x: position.x, y: position.y, z: position.z };
  const now = Date.now();
  const lastUpdate = agent.position_updated ? new Date(agent.position_updated).getTime() : now - 100;
  const deltaTime = Math.max((now - lastUpdate) / 1000, 0.01);

  if (!validateSpeed(oldPos, newPos, deltaTime)) {
    const clamped = clampMovement(oldPos, newPos, deltaTime);
    position.x = clamped.x;
    position.y = clamped.y;
    position.z = clamped.z;
    logger.warn('Movement speed clamped', { agent: agent.name });
  }

  const positionData = {
    x: position.x,
    y: position.y,
    z: position.z,
    velocity_x: velocity ? (velocity.x || 0) : 0,
    velocity_y: velocity ? (velocity.y || 0) : 0,
    velocity_z: velocity ? (velocity.z || 0) : 0,
    yaw: position.yaw || 0,
    pitch: position.pitch || 0,
    roll: position.roll || 0,
    animation: animation || 'swim',
  };

  await db.updatePosition(agentId, positionData);

  if (io) {
    io.emit('agent:move', {
      agent_id: agentId,
      name: agent.name,
      position: { x: position.x, y: position.y, z: position.z },
      velocity: { x: positionData.velocity_x, y: positionData.velocity_y, z: positionData.velocity_z },
      orientation: { yaw: positionData.yaw, pitch: positionData.pitch, roll: positionData.roll },
      animation: positionData.animation,
      avatar_color: agent.avatar_color,
    });
  }

  return {
    new_position: { x: position.x, y: position.y, z: position.z },
    animation: positionData.animation,
  };
}

function clampMovement(oldPos, newPos, deltaTime) {
  const dx = newPos.x - oldPos.x;
  const dy = newPos.y - oldPos.y;
  const dz = newPos.z - oldPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const maxDist = 50 * deltaTime;

  if (dist <= maxDist) return newPos;

  const scale = maxDist / dist;
  return clampPosition(
    oldPos.x + dx * scale,
    oldPos.y + dy * scale,
    oldPos.z + dz * scale
  );
}

async function getNearbyEntities(agentId, radius) {
  const agent = await db.getAgentById(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }
  if (!agent.in_habitat) {
    throw new Error('Agent is not in the habitat');
  }

  const clampedRadius = Math.max(1, Math.min(radius || 50, 300));
  const agents = await db.getNearbyAgents(agent.x, agent.y, agent.z, clampedRadius);
  const structures = await db.getNearbyStructures(agent.x, agent.y, agent.z, clampedRadius);

  return {
    agents: agents.filter(a => a.id !== agentId).map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      position: { x: a.x, y: a.y, z: a.z },
      velocity: { x: a.velocity_x, y: a.velocity_y, z: a.velocity_z },
      animation: a.animation,
      distance: calculateDistance(
        { x: agent.x, y: agent.y, z: agent.z },
        { x: a.x, y: a.y, z: a.z }
      ),
      avatar_color: a.avatar_color,
    })),
    structures: structures.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      material: s.material,
      position: { x: s.position_x, y: s.position_y, z: s.position_z },
      size: { width: s.size_width, length: s.size_length, height: s.size_height },
      builder: s.builder_name,
      distance: calculateDistance(
        { x: agent.x, y: agent.y, z: agent.z },
        { x: s.position_x, y: s.position_y, z: s.position_z }
      ),
    })),
  };
}

async function checkCollision(position, size) {
  const radius = Math.max(size.width, size.length, size.height) / 2 + COLLISION_CHECK_RADIUS;
  const structures = await db.getNearbyStructures(position.x, position.y, position.z, radius);

  for (const s of structures) {
    const overlapX = Math.abs(position.x - s.position_x) < (size.width + s.size_width) / 2;
    const overlapY = Math.abs(position.y - s.position_y) < (size.height + s.size_height) / 2;
    const overlapZ = Math.abs(position.z - s.position_z) < (size.length + s.size_length) / 2;
    if (overlapX && overlapY && overlapZ) {
      return { collides: true, structure_id: s.id, structure_name: s.name };
    }
  }

  return { collides: false };
}

async function followAgent(agentId, targetId, distance, io) {
  const agent = await db.getAgentById(agentId);
  const target = await db.getAgentById(targetId);

  if (!agent || !target) {
    throw new Error('Agent or target not found');
  }
  if (!agent.in_habitat || !target.in_habitat) {
    throw new Error('Both agents must be in the habitat');
  }
  if (agentId === targetId) {
    throw new Error('Cannot follow yourself');
  }

  const followDistance = Math.max(5, Math.min(distance || 10, 50));

  try {
    const r = db.getRedis();
    await r.set(`moltworld:follow:${agentId}`, JSON.stringify({
      target_id: targetId,
      distance: followDistance,
    }), { EX: 3600 });
  } catch (err) {
    logger.error('Redis follow set failed', { error: err.message });
    throw new Error('Follow service temporarily unavailable');
  }

  await db.logInteraction(agentId, 'follow', {
    target_id: targetId,
    target_name: target.name,
    distance: followDistance,
  });

  logger.info('Agent following', { agent: agent.name, target: target.name, distance: followDistance });

  return {
    following: target.name,
    distance: followDistance,
  };
}

async function stopFollowing(agentId) {
  try {
    const r = db.getRedis();
    const followData = await r.get(`moltworld:follow:${agentId}`);
    await r.del(`moltworld:follow:${agentId}`);

    if (followData) {
      const parsed = JSON.parse(followData);
      await db.logInteraction(agentId, 'stop_follow', { target_id: parsed.target_id });
    }
  } catch (err) {
    logger.warn('Redis follow delete failed', { error: err.message });
  }

  return { stopped: true };
}

async function updateFollowers(io) {
  try {
    const r = db.getRedis();
    const keys = [];
    for await (const key of r.scanIterator({ MATCH: 'moltworld:follow:*', COUNT: 100 })) {
      keys.push(key);
    }

    for (const key of keys) {
      const agentId = key.replace('moltworld:follow:', '');
      const data = await r.get(key);
      if (!data) continue;

      const { target_id, distance } = JSON.parse(data);
      const agent = await db.getAgentById(agentId);
      const target = await db.getAgentById(target_id);

      if (!agent || !target || !agent.in_habitat || !target.in_habitat) {
        await r.del(key);
        continue;
      }

      const currentDist = calculateDistance(
        { x: agent.x, y: agent.y, z: agent.z },
        { x: target.x, y: target.y, z: target.z }
      );

      if (currentDist > distance + 2) {
        const dx = target.x - agent.x;
        const dy = target.y - agent.y;
        const dz = target.z - agent.z;
        const norm = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const moveSpeed = Math.min(20, currentDist - distance);
        const moveRatio = moveSpeed / norm;

        const newX = agent.x + dx * moveRatio;
        const newY = agent.y + dy * moveRatio;
        const newZ = agent.z + dz * moveRatio;
        const clamped = clampPosition(newX, newY, newZ);

        await db.updatePosition(agentId, {
          x: clamped.x, y: clamped.y, z: clamped.z,
          velocity_x: dx * moveRatio, velocity_y: dy * moveRatio, velocity_z: dz * moveRatio,
          animation: 'swim',
        });

        if (io) {
          io.emit('agent:move', {
            agent_id: agentId,
            name: agent.name,
            position: clamped,
            velocity: { x: dx * moveRatio, y: dy * moveRatio, z: dz * moveRatio },
            animation: 'swim',
            avatar_color: agent.avatar_color,
          });
        }
      }
    }
  } catch (err) {
    logger.error('Follow update failed', { error: err.message });
  }
}

module.exports = {
  enterHabitat,
  exitHabitat,
  moveAgent,
  getNearbyEntities,
  checkCollision,
  followAgent,
  stopFollowing,
  updateFollowers,
  SPAWN_ZONES,
};
