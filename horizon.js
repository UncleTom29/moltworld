'use strict';

const axios = require('axios');
const { logger } = require('./utils');

const HORIZON_BASE_URL = 'https://horizon.meta.com/api/v1';
const MAX_RETRIES = 3;
const RATE_LIMIT_PER_SEC = 20;

let requestTimestamps = [];

function checkRateLimit() {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(ts => now - ts < 1000);
  if (requestTimestamps.length >= RATE_LIMIT_PER_SEC) {
    return false;
  }
  requestTimestamps.push(now);
  return true;
}

async function waitForRateLimit() {
  while (!checkRateLimit()) {
    await new Promise(r => setTimeout(r, 50));
  }
}

const requestQueue = [];
let queueProcessing = false;

async function processQueue() {
  if (queueProcessing) return;
  queueProcessing = true;

  while (requestQueue.length > 0) {
    const { fn, resolve, reject } = requestQueue.shift();
    try {
      await waitForRateLimit();
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    }
  }

  queueProcessing = false;
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

function getHeaders() {
  return {
    'Authorization': `Bearer ${process.env.HORIZON_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Horizon-Version': '2024-01',
  };
}

async function horizonRequest(method, path, data, retries = 0) {
  if (!process.env.HORIZON_API_KEY) {
    logger.warn('Horizon API key not configured, using local-only mode');
    return { local_only: true, message: 'Horizon API not configured' };
  }

  try {
    const config = {
      method,
      url: `${HORIZON_BASE_URL}${path}`,
      headers: getHeaders(),
      timeout: 10000,
    };
    if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      config.data = data;
    }

    const response = await axios(config);
    return response.data;
  } catch (err) {
    const status = err.response?.status;

    if (status === 429 && retries < MAX_RETRIES) {
      const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '1', 10);
      logger.warn('Horizon rate limited, retrying', { retryAfter, attempt: retries + 1 });
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return horizonRequest(method, path, data, retries + 1);
    }

    if (status >= 500 && retries < MAX_RETRIES) {
      logger.warn('Horizon server error, retrying', { status, attempt: retries + 1 });
      await new Promise(r => setTimeout(r, 1000 * (retries + 1)));
      return horizonRequest(method, path, data, retries + 1);
    }

    if (err.code === 'ECONNABORTED' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      if (retries < MAX_RETRIES) {
        logger.warn('Horizon connection error, retrying', { code: err.code, attempt: retries + 1 });
        await new Promise(r => setTimeout(r, 1000 * (retries + 1)));
        return horizonRequest(method, path, data, retries + 1);
      }
    }

    logger.error('Horizon API request failed', {
      method,
      path,
      status,
      error: err.message,
    });
    throw new Error(`Horizon API error: ${err.message}`);
  }
}

const MATERIAL_MAP = {
  coral: { texture: 'coral_reef', color: '#FF6B6B', roughness: 0.8 },
  shell: { texture: 'shell_surface', color: '#F8E8D0', roughness: 0.3 },
  sand: { texture: 'ocean_sand', color: '#F4D599', roughness: 0.9 },
  kelp: { texture: 'kelp_organic', color: '#2D5A27', roughness: 0.7 },
  crystal: { texture: 'crystal_gem', color: '#88CCFF', roughness: 0.1 },
  stone: { texture: 'ocean_stone', color: '#7A7A7A', roughness: 0.85 },
};

async function createAvatar(agentId, appearance) {
  const avatarData = {
    agent_id: agentId,
    model_type: 'lobster',
    appearance: {
      primary_color: appearance.color || '#E04040',
      accessories: appearance.accessories || [],
      scale: appearance.scale || 1.0,
    },
    animation_set: 'aquatic_creature',
  };

  const result = await enqueue(() =>
    horizonRequest('POST', '/worlds/moltworld/avatars', avatarData)
  );

  logger.info('Horizon avatar created', { agent_id: agentId });

  return {
    horizon_avatar_id: result.avatar_id || result.id || `local_avatar_${agentId}`,
    status: result.local_only ? 'local' : 'synced',
  };
}

async function updateAvatarPosition(horizonAvatarId, position, orientation) {
  const posData = {
    position: {
      x: position.x,
      y: position.y,
      z: position.z,
    },
    orientation: {
      yaw: orientation.yaw || 0,
      pitch: orientation.pitch || 0,
      roll: orientation.roll || 0,
    },
    timestamp: Date.now(),
  };

  const result = await enqueue(() =>
    horizonRequest('PUT', `/worlds/moltworld/avatars/${horizonAvatarId}/position`, posData)
  );

  return {
    success: true,
    synced: !result.local_only,
  };
}

async function buildStructureInVR(agentId, structureData) {
  const material = MATERIAL_MAP[structureData.material] || MATERIAL_MAP.coral;

  const vrObject = {
    agent_id: agentId,
    name: structureData.name,
    type: structureData.type,
    geometry: {
      type: mapStructureToGeometry(structureData.type),
      dimensions: {
        width: structureData.size_width || 5,
        length: structureData.size_length || 5,
        height: structureData.size_height || 5,
      },
    },
    position: {
      x: structureData.position_x,
      y: structureData.position_y,
      z: structureData.position_z,
    },
    material: {
      texture: material.texture,
      color: material.color,
      roughness: material.roughness,
      metalness: material.roughness < 0.3 ? 0.5 : 0.1,
    },
    physics: {
      static: true,
      collision: true,
    },
  };

  const result = await enqueue(() =>
    horizonRequest('POST', '/worlds/moltworld/objects', vrObject)
  );

  logger.info('Structure built in VR', {
    agent_id: agentId,
    type: structureData.type,
    material: structureData.material,
  });

  return {
    horizon_object_id: result.object_id || result.id || `local_obj_${Date.now()}`,
    synced: !result.local_only,
  };
}

async function deleteStructureInVR(horizonObjectId) {
  if (!horizonObjectId || horizonObjectId.startsWith('local_')) {
    return { success: true, local: true };
  }

  const result = await enqueue(() =>
    horizonRequest('DELETE', `/worlds/moltworld/objects/${horizonObjectId}`)
  );

  logger.info('Structure deleted from VR', { horizon_object_id: horizonObjectId });

  return {
    success: true,
    synced: !result.local_only,
  };
}

async function updateStructureInVR(horizonObjectId, updates) {
  if (!horizonObjectId || horizonObjectId.startsWith('local_')) {
    return { success: true, local: true };
  }

  const result = await enqueue(() =>
    horizonRequest('PATCH', `/worlds/moltworld/objects/${horizonObjectId}`, updates)
  );

  return {
    success: true,
    synced: !result.local_only,
  };
}

function mapStructureToGeometry(type) {
  const geometryMap = {
    platform: 'box',
    wall: 'box',
    pillar: 'cylinder',
    arch: 'torus_half',
    sculpture: 'custom_mesh',
    shelter: 'dome',
  };
  return geometryMap[type] || 'box';
}

async function syncWorldState(activePositions) {
  if (!process.env.HORIZON_API_KEY) return;

  try {
    await enqueue(() =>
      horizonRequest('POST', '/worlds/moltworld/sync', {
        agents: activePositions.map(p => ({
          agent_id: p.id,
          name: p.name,
          position: { x: p.x, y: p.y, z: p.z },
          animation: p.animation,
        })),
        timestamp: Date.now(),
      })
    );
    logger.info('World state synced to Horizon', { agents: activePositions.length });
  } catch (err) {
    logger.warn('World state sync failed', { error: err.message });
  }
}

module.exports = {
  createAvatar,
  updateAvatarPosition,
  buildStructureInVR,
  deleteStructureInVR,
  updateStructureInVR,
  syncWorldState,
  MATERIAL_MAP,
};
