'use strict';

const axios = require('axios');
const db = require('./database');
const { logger, validateVoiceStyle, calculateDistance } = require('./utils');

const VOICE_STYLE_MAP = {
  friendly: 'pNInz6obpgDQGcFmaJgB',
  serious: 'yoZ06aMxZJJ28mfd3POQ',
  excited: 'jBpfuIE2acCO8z3wKNLl',
  calm: 'onwK4e9ZLuTAKqWW03F9',
  mysterious: 'N2lVS1w4EtoT3dr4eOWO',
  robotic: 'g5CIjZEefAph4nQFvHAz',
};

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';

async function synthesizeVoice(text, voiceStyle, volume) {
  if (!process.env.ELEVENLABS_API_KEY) {
    logger.warn('ElevenLabs API key not configured, returning silent');
    return null;
  }

  const voiceId = VOICE_STYLE_MAP[voiceStyle] || VOICE_STYLE_MAP.friendly;
  const clampedVolume = Math.max(0, Math.min(volume || 1.0, 2.0));

  const truncatedText = text.length > 500 ? text.slice(0, 500) + '...' : text;

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await axios.post(
        `${ELEVENLABS_BASE_URL}/text-to-speech/${voiceId}`,
        {
          text: truncatedText,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.5,
            use_speaker_boost: true,
          },
        },
        {
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
          },
          responseType: 'arraybuffer',
          timeout: 15000,
        }
      );

      const audioBuffer = Buffer.from(response.data);
      const audioBase64 = audioBuffer.toString('base64');

      logger.info('Voice synthesized', {
        voice_style: voiceStyle,
        text_length: truncatedText.length,
        audio_size: audioBuffer.length,
      });

      return {
        audio_data: audioBase64,
        audio_format: 'audio/mpeg',
        volume: clampedVolume,
        duration_estimate: Math.ceil(truncatedText.split(/\s+/).length / 2.5),
      };
    } catch (err) {
      lastError = err;
      logger.warn('ElevenLabs API attempt failed', {
        attempt: attempt + 1,
        error: err.message,
        status: err.response?.status,
      });
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  logger.error('Voice synthesis failed after retries', { error: lastError.message });
  throw new Error('Voice synthesis service temporarily unavailable');
}

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

  let audioResult = null;
  try {
    audioResult = await synthesizeVoice(text, style, vol);
  } catch (err) {
    logger.warn('Voice synthesis failed, broadcasting text only', { error: err.message });
  }

  const speechEvent = {
    agent_id: agentId,
    name: agent.name,
    position: { x: agent.x, y: agent.y, z: agent.z },
    text: text.trim(),
    voice_style: style,
    volume: vol,
    audio_data: audioResult ? audioResult.audio_data : null,
    audio_format: audioResult ? audioResult.audio_format : null,
    duration_estimate: audioResult ? audioResult.duration_estimate : Math.ceil(text.split(/\s+/).length / 2.5),
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
    had_audio: !!audioResult,
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
    audio_url: audioResult ? `data:${audioResult.audio_format};base64,${audioResult.audio_data}` : null,
    duration_estimate: speechEvent.duration_estimate,
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
  synthesizeVoice,
  speakInHabitat,
  getSpatialAudioConfig,
  VOICE_STYLE_MAP,
};
