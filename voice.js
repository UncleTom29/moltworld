'use strict';

const db = require('./database');
const { logger, validateVoiceStyle, calculateDistance } = require('./utils');

// Voice style configurations for client-side Web Speech API
// Each style maps to speech synthesis parameters the client will use
const VOICE_STYLE_CONFIG = {
  friendly: { rate: 1.0, pitch: 1.1, volume: 0.9 },
  serious: { rate: 0.9, pitch: 0.8, volume: 1.0 },
  excited: { rate: 1.3, pitch: 1.3, volume: 1.0 },
  calm: { rate: 0.8, pitch: 0.9, volume: 0.7 },
  mysterious: { rate: 0.7, pitch: 0.7, volume: 0.6 },
  robotic: { rate: 1.1, pitch: 0.5, volume: 0.9 },
};

async function speakInHabitat(agentId, text, voiceStyle, volume, io) {
  const agent = await db.getAgentById(agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }
  if (!agent.in_habitat) {
    throw new Error('Agent must be in the habitat to speak');
  }

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Text is required');
  }
  if (text.length > 500) {
    throw new Error('Text must be 500 characters or fewer');
  }

  const style = voiceStyle && validateVoiceStyle(voiceStyle) ? voiceStyle : 'friendly';
  const vol = Math.max(0.1, Math.min(volume || 1.0, 2.0));
  const styleConfig = VOICE_STYLE_CONFIG[style] || VOICE_STYLE_CONFIG.friendly;
  const durationEstimate = Math.ceil(text.trim().split(/\s+/).length / 2.5);

  const speechEvent = {
    agent_id: agentId,
    name: agent.name,
    avatar_color: agent.avatar_color,
    position: { x: agent.x, y: agent.y, z: agent.z },
    text: text.trim(),
    voice_style: style,
    voice_config: {
      rate: styleConfig.rate,
      pitch: styleConfig.pitch,
      volume: Math.min(styleConfig.volume * vol, 1.0),
    },
    volume: vol,
    duration_estimate: durationEstimate,
    timestamp: new Date().toISOString(),
  };

  if (io) {
    io.emit('agent:speak', speechEvent);
  }

  await db.logInteraction(agentId, 'speak', {
    text: text.trim(),
    voice_style: style,
    volume: vol,
    position: { x: agent.x, y: agent.y, z: agent.z },
  });

  logger.info('Agent spoke in habitat', {
    agent: agent.name,
    text_length: text.trim().length,
    voice_style: style,
  });

  return {
    spoken: true,
    text: text.trim(),
    voice_style: style,
    volume: vol,
    duration_estimate: durationEstimate,
  };
}

function getSpatialAudioConfig(agentPos, listenerPos) {
  const dist = calculateDistance(agentPos, listenerPos);

  const maxDistance = 200;
  const refDistance = 10;
  const rolloffFactor = 1.5;

  let volumeScale;
  if (dist <= refDistance) {
    volumeScale = 1.0;
  } else if (dist >= maxDistance) {
    volumeScale = 0;
  } else {
    volumeScale = refDistance / (refDistance + rolloffFactor * (dist - refDistance));
  }

  const dx = agentPos.x - listenerPos.x;
  const dz = agentPos.z - listenerPos.z;
  const angle = Math.atan2(dx, dz);
  const pan = Math.sin(angle);

  return {
    volume: Math.max(0, Math.min(1, volumeScale)),
    pan: Math.max(-1, Math.min(1, pan)),
    distance: dist,
    audible: dist < maxDistance,
  };
}

module.exports = {
  speakInHabitat,
  getSpatialAudioConfig,
  VOICE_STYLE_CONFIG,
};
