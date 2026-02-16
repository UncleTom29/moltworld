'use strict';

const { ethers } = require('ethers');
const { logger } = require('./utils');

let provider = null;
const DEV_MODE = process.env.MONAD_DEV_MODE === 'true';
const WORLD_WALLET = (process.env.MONAD_WORLD_WALLET || '').toLowerCase();
const ENTRY_FEE = process.env.MONAD_ENTRY_FEE || '0.1';
const MIN_CONFIRMATIONS = parseInt(process.env.MONAD_MIN_CONFIRMATIONS || '1', 10);

async function connect() {
  if (DEV_MODE) {
    logger.info('Monad gateway running in DEV MODE (tx verification simulated)');
    return;
  }

  const rpcUrl = process.env.MONAD_RPC_URL;
  if (!rpcUrl) {
    throw new Error('MONAD_RPC_URL is required (or set MONAD_DEV_MODE=true for testing)');
  }
  if (!WORLD_WALLET) {
    throw new Error('MONAD_WORLD_WALLET is required');
  }

  provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    const network = await provider.getNetwork();
    logger.info('Connected to Monad', {
      chainId: network.chainId.toString(),
      rpc: rpcUrl.replace(/\/\/.*@/, '//***@'),
    });
  } catch (err) {
    logger.error('Monad RPC connection failed', { error: err.message });
    throw err;
  }
}

async function verifyEntryPayment(txHash) {
  if (!txHash || typeof txHash !== 'string') {
    throw new Error('tx_hash is required');
  }

  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error('Invalid transaction hash format (expected 0x + 64 hex chars)');
  }

  if (DEV_MODE) {
    return {
      verified: true,
      amount: ENTRY_FEE,
      from: '0x' + '0'.repeat(40),
      block: 0,
      dev_mode: true,
    };
  }

  const tx = await provider.getTransaction(txHash);
  if (!tx) {
    throw new Error('Transaction not found on Monad chain');
  }

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    throw new Error('Transaction not yet confirmed');
  }
  if (receipt.status !== 1) {
    throw new Error('Transaction failed on-chain');
  }

  const currentBlock = await provider.getBlockNumber();
  const confirmations = currentBlock - receipt.blockNumber;
  if (confirmations < MIN_CONFIRMATIONS) {
    throw new Error(`Transaction needs ${MIN_CONFIRMATIONS} confirmations, has ${confirmations}`);
  }

  if (tx.to && tx.to.toLowerCase() !== WORLD_WALLET) {
    throw new Error('Transaction recipient is not the Moltworld wallet');
  }

  const minAmount = ethers.parseEther(ENTRY_FEE);
  if (tx.value < minAmount) {
    throw new Error(
      `Insufficient MON payment. Required: ${ENTRY_FEE} MON, received: ${ethers.formatEther(tx.value)} MON`
    );
  }

  return {
    verified: true,
    amount: ethers.formatEther(tx.value),
    from: tx.from,
    block: receipt.blockNumber,
  };
}

function getEntryFee() {
  return ENTRY_FEE;
}

function getWorldWallet() {
  return WORLD_WALLET || '(set MONAD_WORLD_WALLET in .env)';
}

function isDevMode() {
  return DEV_MODE;
}

module.exports = {
  connect,
  verifyEntryPayment,
  getEntryFee,
  getWorldWallet,
  isDevMode,
};
