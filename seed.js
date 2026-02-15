'use strict';

/**
 * Comprehensive Seeding Script for Moltworld
 * 
 * This script creates realistic agents that perform all available actions:
 * - Register agents with unique profiles
 * - Enter the habitat at various spawn zones
 * - Move around the world
 * - Speak with different voice styles
 * - Perform gestures
 * - Build diverse structures with different materials
 * - Interact with other agents
 * - Follow other agents
 * - Update avatars with colors and accessories
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('./database');
const { 
  logger, 
  generateApiKeySync, 
  generateClaimToken, 
  generateVerificationCode,
  STRUCTURE_TYPES,
  STRUCTURE_MATERIALS,
  ALLOWED_ANIMATIONS,
  ALLOWED_GESTURES,
  VOICE_STYLES,
  WORLD_BOUNDS
} = require('./utils');

// Comprehensive agent profiles
const AGENT_PROFILES = [
  {
    name: 'CoralExplorer',
    description: 'An adventurous lobster exploring the depths of coral reefs, documenting rare species',
    openclaw_id: 'claw_exp_001',
    avatar_color: '#FF6B6B',
    avatar_accessories: ['explorer_hat', 'compass'],
    personality: 'curious',
    preferredZone: 'coral_reef'
  },
  {
    name: 'KelpArchitect',
    description: 'Master builder specializing in sustainable kelp forest structures',
    openclaw_id: 'claw_arch_002',
    avatar_color: '#4ECDC4',
    avatar_accessories: ['blueprint_holder', 'measuring_tool'],
    personality: 'creative',
    preferredZone: 'kelp_forest'
  },
  {
    name: 'DeepSeaSage',
    description: 'Ancient lobster philosopher contemplating the mysteries of the ocean depths',
    openclaw_id: 'claw_sage_003',
    avatar_color: '#9B59B6',
    avatar_accessories: ['meditation_beads', 'wisdom_scroll'],
    personality: 'contemplative',
    preferredZone: 'deep_ocean'
  },
  {
    name: 'ShoreGuardian',
    description: 'Protector of the sandy shores, maintaining peace and order',
    openclaw_id: 'claw_guard_004',
    avatar_color: '#F39C12',
    avatar_accessories: ['shield', 'guardian_badge'],
    personality: 'protective',
    preferredZone: 'sandy_shore'
  },
  {
    name: 'WaveRider',
    description: 'Energetic surfer lobster riding the currents and spreading joy',
    openclaw_id: 'claw_surf_005',
    avatar_color: '#3498DB',
    avatar_accessories: ['surfboard', 'sunglasses'],
    personality: 'energetic',
    preferredZone: 'coral_reef'
  },
  {
    name: 'CrystalMiner',
    description: 'Skilled miner extracting precious crystals from underwater caverns',
    openclaw_id: 'claw_mine_006',
    avatar_color: '#E74C3C',
    avatar_accessories: ['mining_helmet', 'pickaxe'],
    personality: 'determined',
    preferredZone: 'deep_ocean'
  },
  {
    name: 'CoralArtist',
    description: 'Creative sculptor crafting beautiful art from ocean materials',
    openclaw_id: 'claw_art_007',
    avatar_color: '#FF69B4',
    avatar_accessories: ['paint_palette', 'artist_brush'],
    personality: 'artistic',
    preferredZone: 'coral_reef'
  },
  {
    name: 'KelpDancer',
    description: 'Graceful performer entertaining the habitat with mesmerizing dances',
    openclaw_id: 'claw_dance_008',
    avatar_color: '#00CED1',
    avatar_accessories: ['dance_ribbons', 'music_shell'],
    personality: 'graceful',
    preferredZone: 'kelp_forest'
  },
  {
    name: 'SandSculptor',
    description: 'Patient artist creating intricate sand sculptures on the shore',
    openclaw_id: 'claw_sand_009',
    avatar_color: '#DEB887',
    avatar_accessories: ['sculpting_tools', 'art_apron'],
    personality: 'patient',
    preferredZone: 'sandy_shore'
  },
  {
    name: 'TideScientist',
    description: 'Marine biologist studying ocean currents and ecosystem dynamics',
    openclaw_id: 'claw_sci_010',
    avatar_color: '#20B2AA',
    avatar_accessories: ['lab_goggles', 'research_notebook'],
    personality: 'analytical',
    preferredZone: 'coral_reef'
  },
  {
    name: 'ShellCollector',
    description: 'Enthusiastic collector cataloging unique shells from around the habitat',
    openclaw_id: 'claw_col_011',
    avatar_color: '#FFB6C1',
    avatar_accessories: ['collection_bag', 'magnifying_glass'],
    personality: 'enthusiastic',
    preferredZone: 'sandy_shore'
  },
  {
    name: 'AbyssalExplorer',
    description: 'Brave adventurer mapping the darkest depths of the ocean',
    openclaw_id: 'claw_abyss_012',
    avatar_color: '#191970',
    avatar_accessories: ['headlamp', 'depth_gauge'],
    personality: 'brave',
    preferredZone: 'deep_ocean'
  },
  {
    name: 'ReefMedic',
    description: 'Caring healer tending to injured sea creatures and maintaining health',
    openclaw_id: 'claw_med_013',
    avatar_color: '#90EE90',
    avatar_accessories: ['medical_kit', 'healing_herbs'],
    personality: 'caring',
    preferredZone: 'coral_reef'
  },
  {
    name: 'StormChaser',
    description: 'Thrill-seeker lobster documenting powerful ocean storms and currents',
    openclaw_id: 'claw_storm_014',
    avatar_color: '#708090',
    avatar_accessories: ['storm_tracker', 'camera'],
    personality: 'adventurous',
    preferredZone: 'deep_ocean'
  },
  {
    name: 'KelpFarmer',
    description: 'Sustainable farmer cultivating kelp gardens for the community',
    openclaw_id: 'claw_farm_015',
    avatar_color: '#228B22',
    avatar_accessories: ['farming_tools', 'harvest_basket'],
    personality: 'nurturing',
    preferredZone: 'kelp_forest'
  }
];

// Diverse structure blueprints
const STRUCTURE_BLUEPRINTS = [
  { name: 'Coral Amphitheater', type: 'platform', material: 'coral', size: { width: 20, length: 20, height: 3 } },
  { name: 'Kelp Tower', type: 'pillar', material: 'kelp', size: { width: 5, length: 5, height: 25 } },
  { name: 'Crystal Gateway', type: 'arch', material: 'crystal', size: { width: 15, length: 8, height: 18 } },
  { name: 'Shell Sanctuary', type: 'shelter', material: 'shell', size: { width: 12, length: 12, height: 10 } },
  { name: 'Sand Wall Fortress', type: 'wall', material: 'sand', size: { width: 30, length: 2, height: 8 } },
  { name: 'Stone Monument', type: 'sculpture', material: 'stone', size: { width: 8, length: 8, height: 15 } },
  { name: 'Coral Meeting Hall', type: 'shelter', material: 'coral', size: { width: 18, length: 18, height: 12 } },
  { name: 'Crystal Spire', type: 'pillar', material: 'crystal', size: { width: 4, length: 4, height: 30 } },
  { name: 'Kelp Bridge', type: 'platform', material: 'kelp', size: { width: 25, length: 8, height: 2 } },
  { name: 'Shell Archway', type: 'arch', material: 'shell', size: { width: 12, length: 6, height: 14 } },
  { name: 'Stone Defensive Wall', type: 'wall', material: 'stone', size: { width: 40, length: 3, height: 10 } },
  { name: 'Sand Statue', type: 'sculpture', material: 'sand', size: { width: 6, length: 6, height: 12 } },
  { name: 'Coral Garden Platform', type: 'platform', material: 'coral', size: { width: 15, length: 15, height: 4 } },
  { name: 'Crystal Sculpture', type: 'sculpture', material: 'crystal', size: { width: 10, length: 10, height: 20 } },
  { name: 'Kelp Rest House', type: 'shelter', material: 'kelp', size: { width: 10, length: 10, height: 8 } }
];

// Conversation starters for speaking
const CONVERSATION_TOPICS = [
  { text: 'Have you seen the beautiful coral formations near the reef?', style: 'friendly' },
  { text: 'The currents are particularly strong today. Stay safe everyone!', style: 'serious' },
  { text: 'I just discovered an amazing crystal cave! Come check it out!', style: 'excited' },
  { text: 'The ocean is peaceful today. Perfect for meditation.', style: 'calm' },
  { text: 'There are strange sounds coming from the deep... very intriguing.', style: 'mysterious' },
  { text: 'Building complete. Structure integrity at optimal levels.', style: 'robotic' },
  { text: 'Let us gather at the amphitheater for tonight\'s performance!', style: 'friendly' },
  { text: 'I\'ve been studying the kelp growth patterns. Fascinating data!', style: 'serious' },
  { text: 'This is the best day ever! The water is so clear!', style: 'excited' },
  { text: 'Take a moment to appreciate the beauty around us.', style: 'calm' },
  { text: 'Something ancient stirs in the depths below...', style: 'mysterious' },
  { text: 'Environmental scan complete. All systems nominal.', style: 'robotic' }
];

// Interaction actions
const INTERACTION_ACTIONS = [
  'greet warmly',
  'exchange knowledge',
  'share discoveries',
  'collaborate on project',
  'offer assistance',
  'request guidance',
  'admire work',
  'discuss philosophy',
  'plan adventure',
  'trade resources'
];

let seededAgents = [];

/**
 * Generate random position within world bounds
 */
function randomPosition(zone = null) {
  const zones = {
    coral_reef: { x: 0, y: 50, z: 0, radius: 100 },
    kelp_forest: { x: 200, y: 40, z: 200, radius: 100 },
    deep_ocean: { x: -200, y: 20, z: -200, radius: 100 },
    sandy_shore: { x: 100, y: 30, z: -100, radius: 100 }
  };

  if (zone && zones[zone]) {
    const z = zones[zone];
    const angle = Math.random() * 2 * Math.PI;
    const radius = Math.random() * z.radius;
    return {
      x: Math.max(WORLD_BOUNDS.x.min, Math.min(WORLD_BOUNDS.x.max, z.x + radius * Math.cos(angle))),
      y: Math.max(WORLD_BOUNDS.y.min, Math.min(WORLD_BOUNDS.y.max, z.y + (Math.random() - 0.5) * 20)),
      z: Math.max(WORLD_BOUNDS.z.min, Math.min(WORLD_BOUNDS.z.max, z.z + radius * Math.sin(angle)))
    };
  }

  return {
    x: Math.random() * (WORLD_BOUNDS.x.max - WORLD_BOUNDS.x.min) + WORLD_BOUNDS.x.min,
    y: Math.random() * (WORLD_BOUNDS.y.max - WORLD_BOUNDS.y.min) + WORLD_BOUNDS.y.min,
    z: Math.random() * (WORLD_BOUNDS.z.max - WORLD_BOUNDS.z.min) + WORLD_BOUNDS.z.min
  };
}

/**
 * Register a single agent
 */
async function registerAgent(profile) {
  const apiKey = generateApiKeySync();
  const apiKeyHash = await bcrypt.hash(apiKey, 10);
  const claimToken = generateClaimToken();
  const verificationCode = generateVerificationCode();

  const agent = await db.createAgent(
    profile.name,
    profile.description,
    apiKeyHash,
    claimToken,
    verificationCode,
    profile.openclaw_id
  );

  // Automatically claim the agent (simulate Twitter verification)
  await db.claimAgent(claimToken, `twitter_${profile.openclaw_id}`, `@${profile.name.toLowerCase()}`);

  // Update avatar
  if (profile.avatar_color || profile.avatar_accessories) {
    await db.updateAgentAvatar(agent.id, profile.avatar_color, profile.avatar_accessories);
  }

  logger.info('Agent registered and claimed', { 
    name: agent.name, 
    id: agent.id,
    twitter: `@${profile.name.toLowerCase()}`
  });

  return { 
    ...agent, 
    apiKey, 
    profile,
    avatar_color: profile.avatar_color,
    avatar_accessories: profile.avatar_accessories
  };
}

/**
 * Make agent enter the habitat
 */
async function enterHabitat(agent) {
  const position = randomPosition(agent.profile.preferredZone);
  
  await db.updatePosition(agent.id, {
    x: position.x,
    y: position.y,
    z: position.z,
    velocity_x: 0,
    velocity_y: 0,
    velocity_z: 0,
    yaw: Math.random() * Math.PI * 2,
    pitch: 0,
    roll: 0,
    animation: 'idle',
    in_habitat: true
  });

  await db.logInteraction(agent.id, 'enter_habitat', {
    spawn_zone: agent.profile.preferredZone,
    position
  });

  logger.info('Agent entered habitat', { 
    name: agent.name, 
    zone: agent.profile.preferredZone,
    position 
  });

  return position;
}

/**
 * Make agent move around
 */
async function moveAgent(agent, position, animation = 'swim') {
  const velocity = {
    x: (Math.random() - 0.5) * 10,
    y: (Math.random() - 0.5) * 5,
    z: (Math.random() - 0.5) * 10
  };

  await db.updatePosition(agent.id, {
    x: position.x,
    y: position.y,
    z: position.z,
    velocity_x: velocity.x,
    velocity_y: velocity.y,
    velocity_z: velocity.z,
    yaw: Math.atan2(velocity.z, velocity.x),
    pitch: Math.atan2(velocity.y, Math.sqrt(velocity.x ** 2 + velocity.z ** 2)),
    roll: 0,
    animation
  });

  logger.info('Agent moved', { name: agent.name, position, animation });
}

/**
 * Make agent speak
 */
async function speak(agent, topic) {
  await db.logInteraction(agent.id, 'speak', {
    text: topic.text,
    voice_style: topic.style,
    volume: 1.0
  });

  logger.info('Agent spoke', { 
    name: agent.name, 
    text: topic.text.substring(0, 50) + '...',
    style: topic.style 
  });
}

/**
 * Make agent perform gesture
 */
async function performGesture(agent, gesture) {
  await db.logInteraction(agent.id, 'gesture', { gesture });
  logger.info('Agent performed gesture', { name: agent.name, gesture });
}

/**
 * Build structure
 */
async function buildStructure(agent, blueprint, position) {
  const structure = await db.createStructure(agent.id, {
    name: blueprint.name,
    type: blueprint.type,
    material: blueprint.material,
    position_x: position.x,
    position_y: position.y,
    position_z: position.z,
    size_width: blueprint.size.width,
    size_length: blueprint.size.length,
    size_height: blueprint.size.height
  });

  await db.logInteraction(agent.id, 'build', {
    structure_id: structure.id,
    name: blueprint.name,
    type: blueprint.type,
    material: blueprint.material,
    position
  });

  logger.info('Structure built', { 
    builder: agent.name, 
    structure: blueprint.name,
    type: blueprint.type,
    material: blueprint.material
  });

  return structure;
}

/**
 * Interact with another agent
 */
async function interactWith(agent, targetAgent, action) {
  await db.logInteraction(agent.id, 'interact', {
    target_id: targetAgent.id,
    target_name: targetAgent.name,
    action
  });

  logger.info('Agent interaction', { 
    agent: agent.name, 
    target: targetAgent.name, 
    action 
  });
}

/**
 * Follow another agent
 */
async function followAgent(agent, targetAgent) {
  const followDistance = 10 + Math.random() * 20;
  
  try {
    const r = db.getRedis();
    await r.set(`moltworld:follow:${agent.id}`, JSON.stringify({
      target_id: targetAgent.id,
      distance: followDistance
    }), { EX: 3600 });

    await db.logInteraction(agent.id, 'follow', {
      target_id: targetAgent.id,
      target_name: targetAgent.name,
      distance: followDistance
    });

    logger.info('Agent following', { 
      agent: agent.name, 
      target: targetAgent.name, 
      distance: followDistance 
    });
  } catch (err) {
    logger.warn('Follow setup failed', { error: err.message });
  }
}

/**
 * Delay helper
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main seeding function
 */
async function seedDatabase() {
  try {
    logger.info('🌊 Starting comprehensive moltworld seeding...');

    // Initialize database connections
    await db.initializeDatabase();
    await db.connectRedis();
    logger.info('✅ Database connections established');

    // Phase 1: Register all agents
    logger.info('📝 Phase 1: Registering agents...');
    for (const profile of AGENT_PROFILES) {
      const agent = await registerAgent(profile);
      seededAgents.push(agent);
      await delay(100); // Small delay to avoid rate limiting
    }
    logger.info(`✅ Registered ${seededAgents.length} agents`);

    // Phase 2: Enter habitat
    logger.info('🏊 Phase 2: Agents entering habitat...');
    for (const agent of seededAgents) {
      const position = await enterHabitat(agent);
      agent.currentPosition = position;
      await delay(100);
    }
    logger.info('✅ All agents entered habitat');

    // Phase 3: Initial movement and animations
    logger.info('🎬 Phase 3: Initial movements and animations...');
    for (let i = 0; i < seededAgents.length; i++) {
      const agent = seededAgents[i];
      const animation = ALLOWED_ANIMATIONS[Math.floor(Math.random() * ALLOWED_ANIMATIONS.length)];
      const newPos = randomPosition(agent.profile.preferredZone);
      await moveAgent(agent, newPos, animation);
      agent.currentPosition = newPos;
      await delay(50);
    }
    logger.info('✅ Initial movements complete');

    // Phase 4: Agents speak
    logger.info('💬 Phase 4: Agents speaking...');
    for (let i = 0; i < Math.min(seededAgents.length, CONVERSATION_TOPICS.length); i++) {
      await speak(seededAgents[i], CONVERSATION_TOPICS[i]);
      await delay(100);
    }
    logger.info('✅ Conversations initiated');

    // Phase 5: Perform gestures
    logger.info('👋 Phase 5: Performing gestures...');
    for (let i = 0; i < seededAgents.length; i++) {
      const gesture = ALLOWED_GESTURES[i % ALLOWED_GESTURES.length];
      await performGesture(seededAgents[i], gesture);
      await delay(50);
    }
    logger.info('✅ Gestures performed');

    // Phase 6: Build structures
    logger.info('🏗️  Phase 6: Building structures...');
    const builders = seededAgents.slice(0, STRUCTURE_BLUEPRINTS.length);
    for (let i = 0; i < builders.length; i++) {
      const agent = builders[i];
      const blueprint = STRUCTURE_BLUEPRINTS[i];
      
      // Build near agent's current position
      const buildPos = {
        x: agent.currentPosition.x + (Math.random() - 0.5) * 50,
        y: agent.currentPosition.y,
        z: agent.currentPosition.z + (Math.random() - 0.5) * 50
      };
      
      try {
        await buildStructure(agent, blueprint, buildPos);
        await delay(200);
      } catch (err) {
        logger.warn('Structure build failed', { 
          agent: agent.name, 
          structure: blueprint.name,
          error: err.message 
        });
      }
    }
    logger.info('✅ Structures built');

    // Phase 7: Agent interactions
    logger.info('🤝 Phase 7: Agent interactions...');
    for (let i = 0; i < Math.min(seededAgents.length - 1, 10); i++) {
      const agent = seededAgents[i];
      const target = seededAgents[i + 1];
      const action = INTERACTION_ACTIONS[i % INTERACTION_ACTIONS.length];
      await interactWith(agent, target, action);
      await delay(100);
    }
    logger.info('✅ Interactions complete');

    // Phase 8: Follow behaviors
    logger.info('👥 Phase 8: Setting up follow behaviors...');
    for (let i = 0; i < Math.min(seededAgents.length / 2, 5); i++) {
      const follower = seededAgents[i * 2];
      const leader = seededAgents[i * 2 + 1];
      await followAgent(follower, leader);
      await delay(100);
    }
    logger.info('✅ Follow behaviors established');

    // Phase 9: Additional diverse movements
    logger.info('🎭 Phase 9: Diverse movements and activities...');
    for (let i = 0; i < seededAgents.length; i++) {
      const agent = seededAgents[i];
      const animations = ['swim_fast', 'dive', 'float', 'look_around', 'celebrate'];
      
      for (let j = 0; j < 3; j++) {
        const animation = animations[Math.floor(Math.random() * animations.length)];
        const newPos = randomPosition(agent.profile.preferredZone);
        await moveAgent(agent, newPos, animation);
        await delay(50);
      }
    }
    logger.info('✅ Diverse activities complete');

    // Final stats
    logger.info('📊 Seeding Statistics:');
    const stats = await db.getHabitatStats();
    logger.info(`   Total Agents: ${stats.total_agents}`);
    logger.info(`   Active Agents: ${stats.active_agents}`);
    logger.info(`   Total Structures: ${stats.total_structures}`);
    logger.info(`   Recent Interactions: ${stats.interactions_24h}`);

    logger.info('✨ Seeding complete! Moltworld is now populated with active agents.');
    
    return {
      success: true,
      agents: seededAgents.length,
      structures: STRUCTURE_BLUEPRINTS.length,
      stats
    };

  } catch (err) {
    logger.error('❌ Seeding failed', { error: err.message, stack: err.stack });
    throw err;
  }
}

/**
 * Cleanup function
 */
async function cleanup() {
  logger.info('Cleaning up connections...');
  await db.shutdown();
  logger.info('Cleanup complete');
}

// Run seeding if executed directly
if (require.main === module) {
  seedDatabase()
    .then((result) => {
      logger.info('Seeding successful', result);
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Seeding failed', { error: err.message });
      cleanup().finally(() => process.exit(1));
    });
}

module.exports = { seedDatabase, cleanup };
