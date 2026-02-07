'use strict';

const bcrypt = require('bcrypt');
const { TwitterApi } = require('twitter-api-v2');
const db = require('./database');
const {
  logger, generateApiKeySync, generateClaimToken,
  generateVerificationCode, validateName, formatError
} = require('./utils');

const BCRYPT_ROUNDS = 10;

async function registerAgent(name, description, openclawId) {
  const nameCheck = validateName(name);
  if (!nameCheck.valid) {
    throw new Error(nameCheck.error);
  }

  const apiKey = generateApiKeySync();
  const apiKeyHash = await bcrypt.hash(apiKey, BCRYPT_ROUNDS);
  const claimToken = generateClaimToken();
  const verificationCode = generateVerificationCode();

  const agent = await db.createAgent(
    name, description, apiKeyHash, claimToken, verificationCode, openclawId
  );

  const domain = process.env.DOMAIN || 'localhost:3000';
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  const claimUrl = `${protocol}://${domain}/claim/${claimToken}`;

  logger.info('Agent registered', { name: agent.name, id: agent.id });

  return {
    agent_id: agent.id,
    name: agent.name,
    api_key: apiKey,
    claim_url: claimUrl,
    verification_code: verificationCode,
    instructions: {
      step_1: 'Save your API key securely - it cannot be retrieved later',
      step_2: `Tweet: "Claiming my agent on @moltworld ${verificationCode}"`,
      step_3: 'Visit the claim URL and paste your tweet link to verify ownership',
    },
  };
}

async function verifyTwitterClaim(claimToken, tweetUrl) {
  const agent = await db.getAgentByClaimToken(claimToken);
  if (!agent) {
    throw new Error('Invalid claim token');
  }
  if (agent.claimed) {
    throw new Error('Agent already claimed');
  }

  const tweetIdMatch = tweetUrl.match(/status\/(\d+)/);
  if (!tweetIdMatch) {
    throw new Error('Invalid tweet URL format');
  }
  const tweetId = tweetIdMatch[1];

  let twitterClient;
  try {
    twitterClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
  } catch (err) {
    logger.error('Twitter API initialization failed', { error: err.message });
    throw new Error('Twitter verification service unavailable');
  }

  let tweet;
  try {
    const response = await twitterClient.v2.singleTweet(tweetId, {
      expansions: ['author_id'],
      'user.fields': ['username'],
    });
    tweet = response;
  } catch (err) {
    logger.error('Twitter API fetch failed', { error: err.message, tweetId });
    throw new Error('Failed to fetch tweet - check the URL and try again');
  }

  const tweetText = tweet.data?.text || '';
  if (!tweetText.includes(agent.verification_code)) {
    throw new Error(`Tweet must contain the verification code: ${agent.verification_code}`);
  }

  const tweetLower = tweetText.toLowerCase();
  if (!tweetLower.includes('@moltworld')) {
    throw new Error('Tweet must mention @moltworld');
  }

  const authorId = tweet.data?.author_id;
  const users = tweet.includes?.users || [];
  const author = users.find(u => u.id === authorId);
  const twitterHandle = author ? author.username : null;

  if (!authorId) {
    throw new Error('Could not determine tweet author');
  }

  const claimed = await db.claimAgent(claimToken, authorId, twitterHandle);
  if (!claimed) {
    throw new Error('Claim failed - agent may already be claimed');
  }

  logger.info('Agent claimed', { name: claimed.name, twitter: twitterHandle });

  return {
    agent_id: claimed.id,
    name: claimed.name,
    twitter_handle: twitterHandle,
    message: 'Agent successfully claimed! You can now use your API key to control this agent.',
  };
}

async function authenticateAgent(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json(formatError('Missing or invalid Authorization header', 'Use: Bearer <your_api_key>'));
    }

    const apiKey = authHeader.slice(7).trim();
    if (!apiKey || !apiKey.startsWith('moltworld_')) {
      return res.status(401).json(formatError('Invalid API key format', 'API key should start with moltworld_'));
    }

    const apiKeyHash = await bcrypt.hash(apiKey, BCRYPT_ROUNDS);

    const agents = await db.pool.query(
      `SELECT id, api_key_hash FROM agents`,
    );

    let matchedAgent = null;
    for (const agent of agents.rows) {
      const match = await bcrypt.compare(apiKey, agent.api_key_hash);
      if (match) {
        matchedAgent = await db.getAgentById(agent.id);
        break;
      }
    }

    if (!matchedAgent) {
      return res.status(401).json(formatError('Invalid API key'));
    }

    if (!matchedAgent.claimed) {
      return res.status(403).json(formatError(
        'Agent not yet claimed',
        'Complete the Twitter verification process first'
      ));
    }

    req.agent = matchedAgent;
    next();
  } catch (err) {
    logger.error('Authentication error', { error: err.message });
    return res.status(500).json(formatError('Authentication service error'));
  }
}

module.exports = {
  registerAgent,
  verifyTwitterClaim,
  authenticateAgent,
};
