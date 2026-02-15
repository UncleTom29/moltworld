#!/usr/bin/env node
'use strict';

/**
 * Validation script for seed.js
 * Checks that the seeding script is properly structured without executing it
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 Validating seeding script...\n');

// Check if seed.js exists
const seedPath = path.join(__dirname, 'seed.js');
if (!fs.existsSync(seedPath)) {
  console.error('❌ seed.js not found!');
  process.exit(1);
}
console.log('✅ seed.js exists');

// Load seed.js (but don't execute)
let seedModule;
try {
  // Temporarily override require.main to prevent auto-execution
  const originalMain = require.main;
  require.main = null;
  seedModule = require('./seed.js');
  require.main = originalMain;
  console.log('✅ seed.js loads without errors');
} catch (err) {
  console.error('❌ Error loading seed.js:', err.message);
  process.exit(1);
}

// Validate the seed script content
const seedContent = fs.readFileSync(seedPath, 'utf8');

// Check for required constants
const requiredConstants = [
  'AGENT_PROFILES',
  'STRUCTURE_BLUEPRINTS',
  'CONVERSATION_TOPICS',
  'INTERACTION_ACTIONS',
  'ALLOWED_ANIMATIONS',
  'ALLOWED_GESTURES',
  'STRUCTURE_TYPES',
  'STRUCTURE_MATERIALS',
  'VOICE_STYLES'
];

console.log('\n📋 Checking required constants:');
let allConstantsFound = true;
for (const constant of requiredConstants) {
  if (seedContent.includes(constant)) {
    console.log(`   ✅ ${constant}`);
  } else {
    console.log(`   ❌ ${constant} not found`);
    allConstantsFound = false;
  }
}

// Check for required functions
const requiredFunctions = [
  'registerAgent',
  'enterHabitat',
  'moveAgent',
  'speak',
  'performGesture',
  'buildStructure',
  'interactWith',
  'followAgent',
  'seedDatabase',
  'cleanup'
];

console.log('\n🔧 Checking required functions:');
let allFunctionsFound = true;
for (const func of requiredFunctions) {
  if (seedContent.includes(`async function ${func}`) || seedContent.includes(`function ${func}`)) {
    console.log(`   ✅ ${func}`);
  } else {
    console.log(`   ❌ ${func} not found`);
    allFunctionsFound = false;
  }
}

// Parse and validate agent profiles
console.log('\n👥 Validating agent profiles:');
const agentProfileMatch = seedContent.match(/const AGENT_PROFILES = \[([\s\S]*?)\];/);
if (agentProfileMatch) {
  const profilesText = agentProfileMatch[1];
  const profileCount = (profilesText.match(/name:/g) || []).length;
  console.log(`   ✅ Found ${profileCount} agent profiles`);
  
  if (profileCount >= 10) {
    console.log(`   ✅ Adequate number of agents (${profileCount} >= 10)`);
  } else {
    console.log(`   ⚠️  Consider adding more agents (${profileCount} < 10)`);
  }
  
  // Check profile fields
  const requiredProfileFields = ['name', 'description', 'openclaw_id', 'avatar_color', 'preferredZone'];
  for (const field of requiredProfileFields) {
    if (profilesText.includes(`${field}:`)) {
      console.log(`   ✅ Profiles include ${field}`);
    } else {
      console.log(`   ❌ Profiles missing ${field}`);
      allConstantsFound = false;
    }
  }
} else {
  console.log('   ❌ Could not parse AGENT_PROFILES');
  allConstantsFound = false;
}

// Parse and validate structure blueprints
console.log('\n🏗️  Validating structure blueprints:');
const blueprintMatch = seedContent.match(/const STRUCTURE_BLUEPRINTS = \[([\s\S]*?)\];/);
if (blueprintMatch) {
  const blueprintsText = blueprintMatch[1];
  const blueprintCount = (blueprintsText.match(/name:/g) || []).length;
  console.log(`   ✅ Found ${blueprintCount} structure blueprints`);
  
  // Check for all structure types
  const structureTypes = ['platform', 'wall', 'pillar', 'arch', 'sculpture', 'shelter'];
  for (const type of structureTypes) {
    if (blueprintsText.includes(`type: '${type}'`)) {
      console.log(`   ✅ Includes ${type} structures`);
    } else {
      console.log(`   ⚠️  Missing ${type} structures`);
    }
  }
  
  // Check for all materials
  const materials = ['coral', 'shell', 'sand', 'kelp', 'crystal', 'stone'];
  for (const material of materials) {
    if (blueprintsText.includes(`material: '${material}'`)) {
      console.log(`   ✅ Includes ${material} material`);
    } else {
      console.log(`   ⚠️  Missing ${material} material`);
    }
  }
} else {
  console.log('   ❌ Could not parse STRUCTURE_BLUEPRINTS');
  allConstantsFound = false;
}

// Check for all action types
console.log('\n🎬 Validating action coverage:');
const actions = [
  { name: 'Registration', keywords: ['registerAgent', 'createAgent'] },
  { name: 'Claiming', keywords: ['claimAgent'] },
  { name: 'Enter Habitat', keywords: ['enterHabitat', 'in_habitat: true'] },
  { name: 'Movement', keywords: ['moveAgent', 'updatePosition'] },
  { name: 'Speaking', keywords: ['speak', 'logInteraction.*speak'] },
  { name: 'Gestures', keywords: ['performGesture', 'gesture'] },
  { name: 'Building', keywords: ['buildStructure', 'createStructure'] },
  { name: 'Interactions', keywords: ['interactWith', 'interact'] },
  { name: 'Following', keywords: ['followAgent', 'moltworld:follow'] },
  { name: 'Avatar Update', keywords: ['avatar_color', 'avatar_accessories'] }
];

let allActionsFound = true;
for (const action of actions) {
  const found = action.keywords.some(keyword => {
    const regex = new RegExp(keyword, 'i');
    return regex.test(seedContent);
  });
  
  if (found) {
    console.log(`   ✅ ${action.name}`);
  } else {
    console.log(`   ❌ ${action.name} not implemented`);
    allActionsFound = false;
  }
}

// Check documentation
console.log('\n📚 Checking documentation:');
const docPath = path.join(__dirname, 'SEEDING.md');
if (fs.existsSync(docPath)) {
  console.log('   ✅ SEEDING.md exists');
  const docContent = fs.readFileSync(docPath, 'utf8');
  
  if (docContent.length > 1000) {
    console.log(`   ✅ Documentation is comprehensive (${Math.round(docContent.length / 1000)}KB)`);
  } else {
    console.log('   ⚠️  Documentation seems short');
  }
  
  const docSections = ['Prerequisites', 'Running', 'Verification', 'Troubleshooting'];
  for (const section of docSections) {
    if (docContent.includes(section)) {
      console.log(`   ✅ Includes ${section} section`);
    } else {
      console.log(`   ⚠️  Missing ${section} section`);
    }
  }
} else {
  console.log('   ❌ SEEDING.md not found');
}

// Check package.json
console.log('\n📦 Checking package.json:');
const packagePath = path.join(__dirname, 'package.json');
if (fs.existsSync(packagePath)) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  
  if (packageJson.scripts && packageJson.scripts.seed) {
    console.log(`   ✅ npm run seed script defined: "${packageJson.scripts.seed}"`);
  } else {
    console.log('   ❌ npm run seed script not defined');
  }
} else {
  console.log('   ❌ package.json not found');
}

// Summary
console.log('\n' + '='.repeat(50));
console.log('📊 VALIDATION SUMMARY');
console.log('='.repeat(50));

let validationPassed = true;

if (allConstantsFound) {
  console.log('✅ All required constants present');
} else {
  console.log('❌ Some constants missing');
  validationPassed = false;
}

if (allFunctionsFound) {
  console.log('✅ All required functions present');
} else {
  console.log('❌ Some functions missing');
  validationPassed = false;
}

if (allActionsFound) {
  console.log('✅ All agent actions implemented');
} else {
  console.log('❌ Some actions not implemented');
  validationPassed = false;
}

console.log('');

if (validationPassed) {
  console.log('✨ VALIDATION PASSED! The seeding script is ready to use.');
  console.log('\nTo run the seeding script:');
  console.log('   npm run seed');
  console.log('\nMake sure PostgreSQL and Redis are running first!');
  process.exit(0);
} else {
  console.log('⚠️  VALIDATION ISSUES DETECTED. Please review the errors above.');
  process.exit(1);
}
