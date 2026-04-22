//walletool.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
require('dotenv').config({ quiet: true });
const { getFilteredWallets: storageGetFilteredWallets } = require('./lib/sqlite_storage');
const { addWallet } = require('./lib/sqlite_storage');
// === AUTO TIMESTAMP EVERY CONSOLE OUTPUT (works in VSCode Terminal) ===
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
function withTimestamp(...args) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return [`[${ts}]`, ...args];
}
console.log = (...args) => originalLog(...withTimestamp(...args));
console.warn = (...args) => originalWarn(...withTimestamp(...args));
console.error = (...args) => originalError(...withTimestamp(...args));
// =====================================================================
const BASE_DIR = 'novelty_wallets';
const FOLDERS = ['start', 'end', 'both'];
const INDEX_PATH = path.join(BASE_DIR, 'novelty_index.json');
// NEW STORAGE: One compact JSONL file per folder
const DB_PATHS = {
  start: path.join(BASE_DIR, 'start', 'start_wallets.jsonl'),
  end: path.join(BASE_DIR, 'end', 'end_wallets.jsonl'),
  both: path.join(BASE_DIR, 'both', 'both_wallets.jsonl')
};
// NEW: Persistent list of already-checked wallets
const CHECKED_PATH = path.join(BASE_DIR, 'checked_wallets.jsonl');
// Import terms from separate file
const baseTerms = require('./baseTerms').default;
const MODE = process.argv[2] || 'generate';
const ALL_ARGS = process.argv.slice(2);
const STOP_FILE = process.env.WALLETOOL_STOP_FILE || '';
const SQLITE_SAVE_BATCH_SIZE = 50;
const SQLITE_SAVE_FLUSH_MS = 250;

let pendingWalletQueue = [];
let flushTimer = null;
let flushInFlight = null;

function stopRequested() {
  if (!STOP_FILE) return false;
  try {
    return fs.existsSync(STOP_FILE);
  } catch (e) {
    return false;
  }
}

function scheduleWalletFlush() {
  if (!isMainThread) return;
  if (flushTimer || pendingWalletQueue.length === 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushWalletQueue();
  }, SQLITE_SAVE_FLUSH_MS);
}

function queueWalletForPersistence(walletRecord) {
  if (!walletRecord) return;
  pendingWalletQueue.push(walletRecord);
  if (pendingWalletQueue.length >= SQLITE_SAVE_BATCH_SIZE) {
    void flushWalletQueue();
    return;
  }
  scheduleWalletFlush();
}

async function flushWalletQueue() {
  if (!isMainThread) return;
  if (flushInFlight) return flushInFlight;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingWalletQueue.length === 0) return;

  flushInFlight = (async () => {
    while (pendingWalletQueue.length > 0) {
      const batch = pendingWalletQueue.splice(0, SQLITE_SAVE_BATCH_SIZE);
      try {
        await addWallet(batch);
      } catch (err) {
        pendingWalletQueue = [...batch, ...pendingWalletQueue];
        console.error(`Failed to flush ${batch.length} wallet(s) to SQLite: ${err.message}`);
        await new Promise(r => setTimeout(r, 500));
        break;
      }
    }
  })();

  try {
    await flushInFlight;
  } finally {
    flushInFlight = null;
    if (pendingWalletQueue.length > 0) {
      scheduleWalletFlush();
    }
  }
}

function clearStopFlag() {
  if (!STOP_FILE) return;
  try {
    if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE);
  } catch (e) { }
}

async function sleepWithStop(ms, stepMs = 500) {
  const start = Date.now();
  while ((Date.now() - start) < ms) {
    if (stopRequested()) return false;
    const remaining = ms - (Date.now() - start);
    await new Promise(r => setTimeout(r, Math.max(1, Math.min(stepMs, remaining))));
  }
  return !stopRequested();
}
// Help
if (ALL_ARGS.includes('help') || ALL_ARGS.includes('?')) {
  console.log(`
=== Solana Novelty Vanity Wallet Generator - Help ===
Commands:
  node vanity-generator.js -> start generating forever (thermal protection optimized for MacBook Air)
  node vanity-generator.js 60 -> generate for 60 minutes then auto-stop
  node vanity-generator.js repeat 6 -> generate 6 min + sleep 6 min, repeat forever
  node vanity-generator.js list -> show all
  node vanity-generator.js list 5 both -> 5+ letters, both only
  node vanity-generator.js list 4 addition -> combined 4+, both sides (x+x)
  node vanity-generator.js search peach -> search peach + all leetspeak
  node vanity-generator.js search "69 tor" 5 addition -> two-word combo across start/end (either side order)
  node vanity-generator.js search peach 5 end
  Types: start | end | both | single | addition
  node vanity-generator.js index -> manually rebuild index
  node vanity-generator.js migrate -> convert ALL old .json files to compact JSONL + auto-delete old files
  node vanity-generator.js cleanup -> safely delete all remaining old .json files
  node vanity-generator.js reindex-matches -> recompute start/end matches from pubkeys and repair folder placement
  node vanity-generator.js balances -> check balances (SKIPS already checked wallets)
  node vanity-generator.js balances force -> force check ALL wallets again
NEW THERMAL MODE (Apple Silicon only):
  Thermal pressure levels (best → worst):
  Nominal → Fair → Moderate → Heavy → Serious → Critical
  Current thermal setting (Apple Silicon):
  • Allows Moderate
  • Triggers cooldown at Serious (or higher)
  • Cools down to Moderate
  Every 30 seconds you see: "Thermal check: Moderate"
  Press Ctrl+C to stop safely
`);
  process.exit(0);
}
// Timer (for one-time generation)
let timerMinutes = null;
const NON_GENERATE_MODES = ['list', 'search', 'index', 'help', 'balances', 'check-balances', 'migrate', 'cleanup', 'reindex-matches'];
if (!NON_GENERATE_MODES.includes(MODE)) {
  let t = parseInt(process.argv[2]);
  if (isNaN(t) && MODE === 'generate') t = parseInt(process.argv[3]);
  if (!isNaN(t) && t > 0) timerMinutes = t;
}
function ensureDirs() {
  if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
  FOLDERS.forEach(folder => {
    const dir = path.join(BASE_DIR, folder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}
// Helper: Uint8Array -> base64
function secretKeyToBase64(secretKey) {
  return Buffer.from(secretKey).toString('base64');
}
// Helper: base64 -> Uint8Array
function base64ToSecretKey(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
function isValidBase58(str) {
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(str);
}
function generateLeetVariants(word) {
  const lowerWord = word.toLowerCase();
  const map = {
    a: ['a', '4'],
    b: ['b', '8'],
    e: ['e', '3'],
    g: ['g', '9', '6'],
    i: ['i', '1'],
    l: ['l', '1'],
    s: ['s', '5'],
    t: ['t', '7'],
    z: ['z', '2']
  };
  const variants = new Set();
  function recurse(index, current) {
    if (index === lowerWord.length) {
      variants.add(current);
      return;
    }
    const char = lowerWord[index];
    const options = map[char] || [char];
    for (let opt of options) recurse(index + 1, current + opt);
  }
  recurse(0, '');
  return Array.from(variants)
    .filter((v) => isValidBase58(v) && v.length >= 2);
}
let allTargets = [];
baseTerms.forEach((term) => {
  allTargets.push(...generateLeetVariants(term));
});
const targets = [...new Set(allTargets)].sort((a, b) => b.length - a.length);
if (isMainThread) {
  console.log(`Loaded ${targets.length} unique search patterns from baseTerms.js`);
}
function findLongestMatch(pubLower, isPrefix) {
  for (let t of targets) {
    if (isPrefix ? pubLower.startsWith(t) : pubLower.endsWith(t)) {
      return t;
    }
  }
  return '';
}
// ==================== OPTIMIZED SAVE WALLET WITH BEAUTIFUL COMPOSITE DISPLAY (GET...KYKE) ====================
function isAllowedHitShape(startMatch, endMatch) {
  const sLen = startMatch ? startMatch.length : 0;
  const eLen = endMatch ? endMatch.length : 0;
  if (!sLen && !eLen) return false;
  // Allow short (2-char) hits only when both sides have a match.
  if ((sLen === 2 || eLen === 2) && !(sLen > 0 && eLen > 0)) return false;
  // Single-side matches must stay at 3+.
  if ((sLen > 0 && eLen === 0 && sLen < 3) || (eLen > 0 && sLen === 0 && eLen < 3)) return false;
  return true;
}

function saveWallet(kp, pubStr, startMatch, endMatch) {
  if (!isAllowedHitShape(startMatch, endMatch)) return false;
  let folderName = '';
  const startUpper = startMatch ? startMatch.toUpperCase() : '';
  const endUpper = endMatch ? endMatch.toUpperCase() : '';
  if (startMatch && endMatch) {
    folderName = 'both';
  } else if (startMatch) {
    folderName = 'start';
  } else if (endMatch) {
    folderName = 'end';
  } else {
    return;
  }
  // === TIERED RARE HIT LOGGING + BEAUTIFUL COMPOSITE DISPLAY (exactly what you asked for) ===
  const sLen = startMatch ? startMatch.length : 0;
  const eLen = endMatch ? endMatch.length : 0;
  let rarityLevel = '';
  if (sLen >= 8 || eLen >= 8 || (sLen >= 5 && eLen >= 5)) {
    rarityLevel = '🔥🔥🔥🔥🔥 ULTRA RARE';
  } else if (sLen >= 7 || eLen >= 7 || (sLen >= 4 && eLen >= 5)) {
    rarityLevel = '🔥🔥🔥 EPIC';
  } else if (sLen >= 6 || eLen >= 6 || (sLen >= 3 && eLen >= 4)) {
    rarityLevel = '🔥🔥 RARE';
  }
  if (rarityLevel) {
    let vanityDisplay = '';
    if (startMatch && endMatch) {
      // EXACTLY WHAT YOU WANTED: GET...KYKE style
      vanityDisplay = `${startUpper}...${endUpper}`;
    } else if (startMatch) {
      vanityDisplay = `${startUpper}...${pubStr.slice(-4).toUpperCase()}`;
    } else if (endMatch) {
      vanityDisplay = `${pubStr.slice(0, 4).toUpperCase()}...${endUpper}`;
    }
    const pubShort = pubStr.substring(0, 8) + '...' + pubStr.substring(pubStr.length - 8);
    console.log(`${rarityLevel} ${sLen && eLen ? `${sLen}+${eLen} BOTH` : (sLen ? `${sLen} START` : `${eLen} END`)} → ${vanityDisplay}  [${pubShort}]`);
  }
  // Save to SQLite database instead of JSONL
  const walletRecord = {
    publicKey: pubStr,
    secretKeyBase64: secretKeyToBase64(kp.secretKey),
    generatedAt: new Date().toISOString(),
    startMatch: startUpper,
    endMatch: endUpper,
    folder: folderName
  };

  if (!isMainThread && parentPort) {
    parentPort.postMessage({ type: 'wallet-found', wallet: walletRecord });
  } else {
    queueWalletForPersistence(walletRecord);
  }

  return true;
}
// ==================== CHECKED WALLETS HELPERS ====================
function loadCheckedWallets() {
  if (!fs.existsSync(CHECKED_PATH)) return new Set();
  const set = new Set();
  try {
    const content = fs.readFileSync(CHECKED_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    lines.forEach(line => {
      try {
        const data = JSON.parse(line);
        if (data.publicKey) set.add(data.publicKey);
      } catch (e) { }
    });
  } catch (e) { }
  return set;
}
function markAsChecked(publicKey) {
  const record = {
    publicKey,
    checkedAt: new Date().toISOString()
  };
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(CHECKED_PATH, line);
}
// ==================== CLEANUP OLD FILES ====================
function runCleanup() {
  console.log('Safe Cleanup: Deleting all old individual .json files...');
  let deletedCount = 0;
  FOLDERS.forEach(folder => {
    const dirPath = path.join(BASE_DIR, folder);
    if (!fs.existsSync(dirPath)) return;
    const oldFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.json') && !f.includes('_wallets.jsonl'));
    if (oldFiles.length > 0) {
      console.log(`[${folder.toUpperCase()}] Deleting ${oldFiles.length} old .json files...`);
      require('child_process').spawnSync('find', [
        dirPath, '-name', '*.json', '!', '-name', '*_wallets.jsonl', '-type', 'f', '-delete'
      ]);
      deletedCount += oldFiles.length;
    }
  });
  console.log(`Cleanup complete! Deleted ${deletedCount} old .json files.`);
  buildIndex();
}
// ==================== MIGRATION SCRIPT ====================
function runMigration() {
  console.log('Starting Migration: Old .json files → Compact JSONL...');
  ensureDirs();
  let totalMigrated = 0;
  let totalSkipped = 0;
  const existingPubkeys = new Set();
  FOLDERS.forEach(folder => {
    const jsonlPath = DB_PATHS[folder];
    if (fs.existsSync(jsonlPath)) {
      try {
        const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
        lines.forEach(line => {
          if (line.trim()) {
            try {
              const data = JSON.parse(line);
              if (data.publicKey) existingPubkeys.add(data.publicKey);
            } catch (e) { }
          }
        });
      } catch (e) { }
    }
  });
  console.log(`Found ${existingPubkeys.size} already-migrated wallets.`);
  for (const folder of FOLDERS) {
    const dirPath = path.join(BASE_DIR, folder);
    if (!fs.existsSync(dirPath)) continue;
    const oldFiles = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.json') && !f.includes('_wallets.jsonl'));
    if (oldFiles.length === 0) {
      console.log(`[${folder.toUpperCase()}] No old .json files to migrate.`);
      continue;
    }
    console.log(`[${folder.toUpperCase()}] Migrating ${oldFiles.length} old files...`);
    const jsonlPath = DB_PATHS[folder];
    for (const file of oldFiles) {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data.publicKey || !data.secretKey) {
          totalSkipped++;
          continue;
        }
        if (existingPubkeys.has(data.publicKey)) {
          totalSkipped++;
          continue;
        }
        const record = {
          publicKey: data.publicKey,
          secretKeyBase64: secretKeyToBase64(data.secretKey),
          generatedAt: data.generatedAt || new Date().toISOString(),
          startMatch: data.startMatch || '',
          endMatch: data.endMatch || '',
          type: folder
        };
        const line = JSON.stringify(record) + '\n';
        fs.appendFileSync(jsonlPath, line);
        existingPubkeys.add(data.publicKey);
        totalMigrated++;
      } catch (e) {
        console.warn(`Failed to migrate ${file}: ${e.message}`);
        totalSkipped++;
      }
    }
  }
  console.log(`Migration complete! Migrated: ${totalMigrated} | Skipped: ${totalSkipped}`);
  console.log('Auto-cleaning up old .json files now...');
  runCleanup();
}
// ==================== LIGHTWEIGHT INDEXING SYSTEM (CRASH-FIXED) ====================
function countJsonlLinesSync(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const chunkSize = 1024 * 1024; // 1MB chunks to avoid loading huge files into memory
  const buffer = Buffer.allocUnsafe(chunkSize);
  let bytesRead = 0;
  let totalLines = 0;
  let totalBytes = 0;
  let lastByte = null;
  try {
    do {
      bytesRead = fs.readSync(fd, buffer, 0, chunkSize, null);
      if (bytesRead > 0) {
        totalBytes += bytesRead;
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] === 10) totalLines++; // '\n'
        }
        lastByte = buffer[bytesRead - 1];
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  if (totalBytes > 0 && lastByte !== 10) totalLines++;
  return totalLines;
}
function buildIndex() {
  console.log('Building lightweight novelty wallet index (metadata only)...');
  let totalWallets = 0;
  const byFolder = { start: 0, end: 0, both: 0 };
  FOLDERS.forEach((folder) => {
    const jsonlPath = DB_PATHS[folder];
    if (!fs.existsSync(jsonlPath)) {
      byFolder[folder] = 0;
      return;
    }
    try {
      const lineCount = countJsonlLinesSync(jsonlPath);
      byFolder[folder] = lineCount;
      totalWallets += lineCount;
    } catch (e) {
      console.warn(`Warning: Could not read ${folder}_wallets.jsonl (${e.code || 'ERR'}: ${e.message})`);
      byFolder[folder] = 0;
    }
  });
  const indexData = {
    lastUpdated: new Date().toISOString(),
    totalWallets: totalWallets,
    byFolder: byFolder
  };
  try {
    fs.writeFileSync(INDEX_PATH, JSON.stringify(indexData, null, 2));
    console.log(`Lightweight index built successfully with ${totalWallets} wallets`);
  } catch (e) {
    console.warn(`Index write skipped (${e.code || 'ERR'}). Continuing with in-memory index only.`);
  }
  return indexData;
}
function loadOrBuildIndex() {
  if (fs.existsSync(INDEX_PATH)) {
    try {
      const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      console.log(`Loaded lightweight index with ${index.totalWallets} wallets (last updated: ${index.lastUpdated})`);
      return index;
    } catch (e) {
      console.log('Index file corrupted. Rebuilding...');
    }
  }
  return buildIndex();
}
// NEW: Full wallet loader for balance checks (scans JSONL directly - no huge index)
function getAllWallets() {
  const allWallets = [];
  FOLDERS.forEach((folder) => {
    const jsonlPath = DB_PATHS[folder];
    if (!fs.existsSync(jsonlPath)) return;
    try {
      const content = fs.readFileSync(jsonlPath, 'utf8');
      const lines = content.trim().split('\n').filter(l => l.trim().length > 0);
      lines.forEach((line, lineIdx) => {
        try {
          const data = JSON.parse(line);
          const startLen = data.startMatch ? data.startMatch.length : 0;
          const endLen = data.endMatch ? data.endMatch.length : 0;
          allWallets.push({
            publicKey: data.publicKey,
            startMatch: data.startMatch || null,
            endMatch: data.endMatch || null,
            generatedAt: data.generatedAt,
            folder: folder,
            startLen: startLen,
            endLen: endLen,
            matchLen: startLen + endLen,
            filePath: jsonlPath,
            lineIndex: lineIdx,
            isLegacy: false
          });
        } catch (e) { }
      });
    } catch (e) {
      console.warn(`Warning: Could not parse ${folder}_wallets.jsonl`);
    }
  });
  // Legacy individual .json files (kept for compatibility)
  FOLDERS.forEach((folder) => {
    const dirPath = path.join(BASE_DIR, folder);
    if (!fs.existsSync(dirPath)) return;
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json') && !f.includes('_wallets'));
    files.forEach((file) => {
      try {
        const filePath = path.join(dirPath, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const startLen = data.startMatch ? data.startMatch.length : 0;
        const endLen = data.endMatch ? data.endMatch.length : 0;
        allWallets.push({
          publicKey: data.publicKey,
          startMatch: data.startMatch || null,
          endMatch: data.endMatch || null,
          generatedAt: data.generatedAt,
          folder: folder,
          startLen: startLen,
          endLen: endLen,
          matchLen: startLen + endLen,
          filePath: filePath,
          isLegacy: true
        });
      } catch (e) {
        console.warn(`Warning: Could not parse legacy ${file}`);
      }
    });
  });
  return allWallets;
}

function classifyMatchForStorage(pubKey, fallbackStart = '', fallbackEnd = '') {
  const pubLower = pubKey.toLowerCase();
  const recomputedStart = findLongestMatch(pubLower, true) || '';
  const recomputedEnd = findLongestMatch(pubLower, false) || '';
  if (isAllowedHitShape(recomputedStart, recomputedEnd)) {
    return { startMatch: recomputedStart.toUpperCase(), endMatch: recomputedEnd.toUpperCase() };
  }

  const legacyStart = (fallbackStart || '').toLowerCase();
  const legacyEnd = (fallbackEnd || '').toLowerCase();
  if (isAllowedHitShape(legacyStart, legacyEnd)) {
    return { startMatch: legacyStart.toUpperCase(), endMatch: legacyEnd.toUpperCase() };
  }

  return { startMatch: '', endMatch: '' };
}

function runReindexMatches() {
  ensureDirs();
  console.log('Reindexing wallet matches from public keys (including 2-char combo support)...');
  const byFolderOut = { start: [], end: [], both: [] };
  const seen = new Set();
  let scanned = 0;
  let rewritten = 0;
  let upgradedToBoth = 0;
  let skipped = 0;
  FOLDERS.forEach((folder) => {
    const jsonlPath = DB_PATHS[folder];
    if (!fs.existsSync(jsonlPath)) return;
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    lines.forEach((line) => {
      scanned++;
      try {
        const data = JSON.parse(line);
        if (!data || !data.publicKey) {
          skipped++;
          return;
        }
        if (seen.has(data.publicKey)) {
          skipped++;
          return;
        }
        seen.add(data.publicKey);

        const prevHadBoth = !!(data.startMatch && data.endMatch);
        const normalized = classifyMatchForStorage(data.publicKey, data.startMatch, data.endMatch);
        if (!normalized.startMatch && !normalized.endMatch) {
          skipped++;
          return;
        }

        const outFolder = normalized.startMatch && normalized.endMatch
          ? 'both'
          : normalized.startMatch
            ? 'start'
            : 'end';

        const outRecord = {
          publicKey: data.publicKey,
          secretKeyBase64: data.secretKeyBase64 || '',
          generatedAt: data.generatedAt || new Date().toISOString(),
          startMatch: normalized.startMatch,
          endMatch: normalized.endMatch,
          type: outFolder
        };

        if (!prevHadBoth && outFolder === 'both') upgradedToBoth++;
        byFolderOut[outFolder].push(JSON.stringify(outRecord));
        rewritten++;
      } catch (e) {
        skipped++;
      }
    });
  });

  FOLDERS.forEach((folder) => {
    const jsonlPath = DB_PATHS[folder];
    const payload = byFolderOut[folder].length ? `${byFolderOut[folder].join('\n')}\n` : '';
    fs.writeFileSync(jsonlPath, payload);
  });

  buildIndex();
  console.log(`Reindex complete. Scanned: ${scanned}, Rewritten: ${rewritten}, Upgraded to BOTH: ${upgradedToBoth}, Skipped: ${skipped}`);
}
// NEW: Streaming filtered loader for list/search (memory-efficient, no full index load)
function matchesTypeFilter(typeFilter, folder, startLen, endLen, minSideLength = 2) {
  if (!typeFilter) return true;
  if (['start', 'end', 'both'].includes(typeFilter)) return folder === typeFilter;
  if (typeFilter === 'single') return (startLen > 0 && endLen === 0) || (endLen > 0 && startLen === 0);
  if (typeFilter === 'addition') return startLen >= minSideLength && endLen >= minSideLength;
  return true;
}

function buildSearchCriteria(searchInput = '') {
  const input = (searchInput || '').trim().toLowerCase();
  if (!input) return { mode: 'none', variants: [] };
  const parts = input.split(/[,\s+]+/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      mode: 'pair',
      first: generateLeetVariants(parts[0]).map(v => v.toUpperCase()),
      second: generateLeetVariants(parts[1]).map(v => v.toUpperCase())
    };
  }
  return {
    mode: 'single',
    variants: generateLeetVariants(parts[0]).map(v => v.toUpperCase())
  };
}

function getFilteredWallets(minLength = 3, typeFilter = null, searchInput = '', minSideLength = 2) {
  const filtered = [];
  const searchCriteria = buildSearchCriteria(searchInput);
  FOLDERS.forEach((folder) => {
    const jsonlPath = DB_PATHS[folder];
    if (!fs.existsSync(jsonlPath)) return;
    try {
      const content = fs.readFileSync(jsonlPath, 'utf8');
      const lines = content.trim().split('\n').filter(l => l.trim().length > 0);
      lines.forEach((line, lineIdx) => {
        try {
          const data = JSON.parse(line);
          const sLen = data.startMatch ? data.startMatch.length : 0;
          const eLen = data.endMatch ? data.endMatch.length : 0;
          if (!matchesTypeFilter(typeFilter, folder, sLen, eLen, minSideLength)) return;
          const matchLen = sLen + eLen;
          if (matchLen < minLength) return;
          let matchesSearch = true;
          if (searchCriteria.mode !== 'none') {
            const s = (data.startMatch || '').toUpperCase();
            const e = (data.endMatch || '').toUpperCase();
            if (searchCriteria.mode === 'single') {
              matchesSearch = searchCriteria.variants.includes(s) || searchCriteria.variants.includes(e);
            } else if (searchCriteria.mode === 'pair') {
              const firstOnStartSecondOnEnd = searchCriteria.first.includes(s) && searchCriteria.second.includes(e);
              const secondOnStartFirstOnEnd = searchCriteria.second.includes(s) && searchCriteria.first.includes(e);
              matchesSearch = firstOnStartSecondOnEnd || secondOnStartFirstOnEnd;
            }
          }
          if (matchesSearch) {
            filtered.push({
              publicKey: data.publicKey,
              startMatch: data.startMatch || null,
              endMatch: data.endMatch || null,
              generatedAt: data.generatedAt,
              folder: folder,
              startLen: sLen,
              endLen: eLen,
              matchLen: matchLen,
              filePath: jsonlPath,
              lineIndex: lineIdx,
              isLegacy: false
            });
          }
        } catch (e) { }
      });
    } catch (e) {
      console.warn(`Warning: Could not parse ${folder}_wallets.jsonl`);
    }
  });
  return filtered;
}
// =========================================================
async function checkAllBalances() {
  console.log('Smart Balance Checker for Novelty Wallets...');
  ensureDirs();
  const rpcUrl = process.env.MAINNET_ENDPOINT;
  if (!rpcUrl) {
    console.error('Error: MAINNET_ENDPOINT not set in .env file.');
    console.log('Create .env with: MAINNET_ENDPOINT=https://your-fast-rpc-endpoint');
    process.exit(1);
  }
  const forceMode = ALL_ARGS.includes('force') || ALL_ARGS.includes('--force');
  const connection = new Connection(rpcUrl, 'confirmed');
  console.log(`Using RPC: ${rpcUrl}`);
  if (forceMode) console.log('FORCE MODE: Checking every wallet (ignoring previous checks)');
  const allWallets = getAllWallets();
  const checkedSet = forceMode ? new Set() : loadCheckedWallets();
  const walletsToCheck = allWallets.filter(w => !checkedSet.has(w.publicKey));
  console.log(`Total registered wallets : ${allWallets.length}`);
  console.log(`Already checked : ${checkedSet.size}`);
  console.log(`Checking this run : ${walletsToCheck.length} wallets\n`);
  if (walletsToCheck.length === 0 && !forceMode) {
    console.log('All wallets have already been checked. Use "node vanity-generator.js balances force" to re-check everything.');
    process.exit(0);
  }
  const results = [];
  let foundWithBalance = 0;
  let processed = 0;
  for (const w of walletsToCheck) {
    try {
      const pubKey = new PublicKey(w.publicKey);
      const solLamports = await connection.getBalance(pubKey);
      const solBalance = solLamports / LAMPORTS_PER_SOL;
      const tokenAccountsRes = await connection.getParsedTokenAccountsByOwner(pubKey, {
        programId: TOKEN_PROGRAM_ID,
      });
      const tokens = [];
      for (const { pubkey: tokenAccountPubkey, account } of tokenAccountsRes.value) {
        const parsed = account.data.parsed.info;
        const uiAmount = parsed.tokenAmount.uiAmount || 0;
        if (uiAmount > 0) {
          tokens.push({
            mint: parsed.mint,
            mintShort: parsed.mint.slice(0, 8) + '...' + parsed.mint.slice(-4),
            amount: uiAmount,
            decimals: parsed.tokenAmount.decimals,
            tokenAccount: tokenAccountPubkey.toBase58(),
            tokenAccountShort: tokenAccountPubkey.toBase58().slice(0, 8) + '...' + tokenAccountPubkey.toBase58().slice(-4)
          });
        }
      }
      markAsChecked(w.publicKey);
      if (solBalance > 0 || tokens.length > 0) {
        foundWithBalance++;
        let secretKeyArray;
        if (w.isLegacy) {
          const data = JSON.parse(fs.readFileSync(w.filePath, 'utf8'));
          secretKeyArray = data.secretKey;
        } else {
          const jsonlContent = fs.readFileSync(w.filePath, 'utf8').split('\n');
          const record = JSON.parse(jsonlContent[w.lineIndex]);
          secretKeyArray = Array.from(base64ToSecretKey(record.secretKeyBase64));
        }
        const shortPub = w.publicKey.substring(0, 10) + '...' + w.publicKey.substring(w.publicKey.length - 10);
        console.log(`BALANCE FOUND → ${shortPub} [${w.folder.toUpperCase()}]`);
        if (solBalance > 0) console.log(` SOL: ${solBalance.toFixed(6)} SOL`);
        if (tokens.length > 0) {
          console.log(` Tokens (${tokens.length}):`);
          tokens.forEach(t => console.log(` ${t.amount} ${t.mintShort}`));
        }
        console.log(` File: ${path.basename(w.filePath)}`);
        results.push({
          rank: foundWithBalance,
          publicKey: w.publicKey,
          publicKeyShort: shortPub,
          secretKey: secretKeyArray,
          solBalance: parseFloat(solBalance.toFixed(9)),
          solLamports: solLamports,
          tokens: tokens,
          tokenCount: tokens.length,
          folder: w.folder,
          startMatch: w.startMatch || null,
          endMatch: w.endMatch || null,
          matchLen: w.matchLen,
          generatedAt: w.generatedAt,
          filePath: w.filePath,
          importTip: `// Use: const kp = Keypair.fromSecretKey(new Uint8Array(${JSON.stringify(secretKeyArray)}))`
        });
      }
    } catch (err) {
      console.warn(`Skipped ${w.publicKey.slice(0, 12)}... (error: ${err.message.slice(0, 60)})`);
      markAsChecked(w.publicKey);
    }
    processed++;
    if (processed % 200 === 0) {
      const percent = Math.round((processed / walletsToCheck.length) * 100);
      console.log(`Progress: ${processed}/${walletsToCheck.length} wallets checked (${percent}%)`);
    }
  }
  results.sort((a, b) => {
    if (b.solBalance !== a.solBalance) return b.solBalance - a.solBalance;
    return b.tokenCount - a.tokenCount;
  });
  const summaryTable = results.map(r => ({
    Rank: r.rank.toString().padStart(2),
    Type: r.folder.toUpperCase(),
    SOL: r.solBalance.toFixed(4),
    Tokens: r.tokenCount,
    'Public Key': r.publicKeyShort,
    'File': path.basename(r.filePath)
  }));
  console.table(summaryTable);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(BASE_DIR, `novelty_balances_${timestamp}.json`);
  const exportData = {
    generatedAt: new Date().toISOString(),
    rpcUsed: rpcUrl,
    totalScannedThisRun: walletsToCheck.length,
    totalWallets: allWallets.length,
    foundWithBalance: results.length,
    warning: 'THIS FILE CONTAINS PRIVATE KEYS (secretKey). KEEP IT SECURE AND DELETE AFTER USE!',
    wallets: results
  };
  fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2));
  console.log(`Detailed JSON report saved: ${jsonPath}`);
  const mdPath = path.join(BASE_DIR, `novelty_balances_${timestamp}.md`);
  let mdContent = `# Novelty Wallets with Balance (${new Date().toISOString().slice(0, 19)})\n\n`;
  mdContent += `**RPC**: ${rpcUrl}\n`;
  mdContent += `**Scanned this run**: ${walletsToCheck.length} | **Found**: ${results.length} with balance/tokens\n\n`;
  mdContent += `| Rank | Type | SOL Balance | Tokens | Public Key (short) | File |\n`;
  mdContent += `|------|------|-------------|--------|--------------------|------|\n`;
  results.forEach(r => {
    const tokenStr = r.tokenCount > 0 ? r.tokenCount : '-';
    mdContent += `| ${r.rank} | ${r.folder.toUpperCase()} | ${r.solBalance.toFixed(4)} | ${tokenStr} | ${r.publicKeyShort} | ${path.basename(r.filePath)} |\n`;
  });
  mdContent += `\n**WARNING**: This report contains private keys in the accompanying JSON file. Delete both files after use.\n`;
  fs.writeFileSync(mdPath, mdContent);
  console.log(`Markdown table report saved: ${mdPath}`);
  console.log(`Balance check complete. Found ${results.length} wallet(s) with SOL or tokens.`);
  console.log(`Marked ${processed} wallets as checked for future runs.`);
}
// ==================== THERMAL MONITORING (Apple Silicon only) ====================
let thermalWarningShown = false;
const THERMAL_LEVEL_ORDER = {
  Unknown: 0,
  Nominal: 1,
  Fair: 2,
  Moderate: 3,
  Heavy: 4,
  Serious: 5,
  Critical: 6
};

function thermalAtOrAbove(level, threshold) {
  const lvl = THERMAL_LEVEL_ORDER[level] || 0;
  const th = THERMAL_LEVEL_ORDER[threshold] || 0;
  return lvl >= th;
}

function thermalAtOrBelow(level, threshold) {
  const lvl = THERMAL_LEVEL_ORDER[level] || 0;
  const th = THERMAL_LEVEL_ORDER[threshold] || 0;
  return lvl <= th;
}

function getThermalPressure() {
  const commands = [
    'powermetrics -s thermal -n 1 -i 500 --hide-cpu-duty-cycle',
    'sudo powermetrics -s thermal -n 1 -i 500 --hide-cpu-duty-cycle'
  ];
  for (const cmd of commands) {
    try {
      const output = execSync(cmd, {
        timeout: 2000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const match = output.match(/pressure level:\s*(\w+)/i);
      if (match) {
        const level = match[1].trim();
        if (cmd.includes('sudo') && !thermalWarningShown) {
          console.log('✅ powermetrics now using sudo (password asked once)');
          thermalWarningShown = true;
        }
        return level;
      }
    } catch (e) { }
  }
  if (!thermalWarningShown) {
    console.log('⚠️ Thermal monitoring unavailable (powermetrics needs sudo or is blocked).');
    console.log(' Run once with: sudo node vanity-generator.js');
    thermalWarningShown = true;
  }
  return 'Unknown';
}
function isMacBookAir() {
  try {
    // On newer Apple Silicon, `hw.model` can be generic (e.g. Mac14,15),
    // so prefer the human-readable model name first.
    const hw = execSync('system_profiler SPHardwareDataType', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toLowerCase();
    const modelNameMatch = hw.match(/model name:\s*(.+)/);
    if (modelNameMatch && modelNameMatch[1]) {
      return modelNameMatch[1].includes('macbook air');
    }
  } catch (e) {
    // Fall through to sysctl fallback.
  }
  try {
    const model = execSync('sysctl -n hw.model', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim().toLowerCase();
    return model.includes('macbookair');
  } catch (e) {
    return false;
  }
}
async function coolDownUntilSafe(target = 'Fair', checkIntervalMs = 15000, maxWaitMinutes = 12) {
  console.log(`🌡️ Starting smart cooldown. Waiting until ≤ ${target}...`);
  const startWait = Date.now();
  let attempts = 0;
  while (true) {
    attempts++;
    const pressure = getThermalPressure();
    console.log(` Thermal check #${attempts}: ${pressure}`);
    if (pressure === 'Unknown' || thermalAtOrBelow(pressure, target)) {
      console.log(`✅ Thermal pressure safe (${pressure}). Resuming generation.`);
      return;
    }
    if ((Date.now() - startWait) / 60000 > maxWaitMinutes) {
      console.log(`⚠️ Max cooldown time reached (${maxWaitMinutes} min). Forcing resume anyway.`);
      return;
    }
    await new Promise(r => setTimeout(r, checkIntervalMs));
  }
}
// ==================== GRACEFUL SHUTDOWN HELPERS ====================
async function waitForWorkersToExit(workers, timeoutMs = 2000) {
  const exitPromises = workers.map(w => new Promise(resolve => {
    w.once('exit', () => resolve(true));
    w.once('error', () => resolve(false));
  }));
  const timeout = new Promise(resolve => setTimeout(() => resolve(false), timeoutMs));
  const results = await Promise.race([Promise.all(exitPromises), timeout]);
  return results;
}
function forceGC() {
  if (global.gc) {
    global.gc();
    console.log('Forced garbage collection');
  }
}
// ==================== REPEATING GENERATION CYCLE ====================
async function runRepeatingGeneration(cycleMinutes) {
  clearStopFlag();
  console.log(`REPEAT GENERATION MODE ENABLED - Cycle: ${cycleMinutes} minutes generate + ${cycleMinutes} minutes sleep`);
  console.log('Thermal protection ACTIVE (Apple Silicon). Will auto-extend breaks if CPU gets hot.');
  console.log('Press Ctrl+C to stop safely (full graceful shutdown now active).\n');
  const isAir = isMacBookAir();
  const triggerLevel = 'Serious';
  const coolToLevel = 'Moderate';
  console.log(`Detected: ${isAir ? 'MacBook Air (fanless)' : 'MacBook Pro'}`);
  console.log(`Repeat thermal policy: pause at ${triggerLevel}+ and resume at ${coolToLevel} or lower.`);
  let cycleCount = 0;
  let currentWorkers = [];
  const gracefulShutdown = async () => {
    console.log('\n🛑 Stopping all workers gracefully...');
    stopRequestedFlag = true;
    for (const worker of currentWorkers) {
      worker.postMessage({ type: 'shutdown' });
    }
    // Wait for all workers to finish
    let remaining = currentWorkers.length;
    for (const worker of currentWorkers) {
      worker.on('message', (msg) => {
        if (msg.type === 'shutdown_complete') {
          remaining--;
          if (remaining === 0) {
            void flushWalletQueue().then(() => {
              console.log('All workers stopped cleanly. SQLite database updated. Memory should now be released.');
              process.exit(0);
            });
          }
        }
      });
    }
    // Force exit after 10 seconds
    setTimeout(() => {
      console.log('Force exit after timeout');
      process.exit(0);
    }, 10000);
  };
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
  process.on('beforeExit', () => {
    forceGC();
  });
  while (true) {
    if (stopRequested()) {
      console.log('Stop flag detected. Exiting repeat mode gracefully...');
      await gracefulShutdown();
      return;
    }
    cycleCount++;
    console.log(`Starting generation cycle ${cycleCount} for ${cycleMinutes} minutes...`);
    const numWorkers = Math.min(8, os.cpus().length);
    const workers = [];
    let totalKeys = 0;
    const cycleStartTime = Date.now();
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(__filename, { workerData: { id: i } });
      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          totalKeys += msg.count;
          const elapsed = (Date.now() - cycleStartTime) / 1000;
          if (totalKeys % 500000 === 0) {
            const rate = Math.floor(totalKeys / elapsed);
            console.log(`Progress: ${Math.floor(totalKeys / 1000000)}M keys | ~${rate} keys/sec`);
          }
        } else if (msg.type === 'wallet-found' && msg.wallet) {
          queueWalletForPersistence(msg.wallet);
        }
      });
      workers.push(worker);
    }
    currentWorkers = [...workers];
    let coolingInProgress = false;
    let thermalCheckRunning = false;
    const thermalMonitor = setInterval(async () => {
      if (thermalCheckRunning || coolingInProgress) return;
      thermalCheckRunning = true;
      try {
        const pressure = getThermalPressure();
        console.log(`Thermal check (cycle ${cycleCount}): ${pressure}`);
        if (thermalAtOrAbove(pressure, triggerLevel)) {
          coolingInProgress = true;
          console.log(`🔥 Thermal pressure ${pressure} reached during repeat cycle - pausing workers to cool down...`);
          workers.forEach(w => w.postMessage({ type: 'pause' }));
          await new Promise(r => setTimeout(r, 1500));
          await coolDownUntilSafe(coolToLevel, 15000, 12);
          console.log('✅ Cooled down in repeat cycle - resuming workers...');
          workers.forEach(w => w.postMessage({ type: 'resume' }));
          coolingInProgress = false;
        }
      } finally {
        thermalCheckRunning = false;
      }
    }, 30000);

    const completedCycle = await sleepWithStop(cycleMinutes * 60 * 1000, 1000);
    clearInterval(thermalMonitor);
    const actualMinutes = ((Date.now() - cycleStartTime) / 60000).toFixed(2);
    console.log(`Cycle ${cycleCount} finished after ${actualMinutes} minutes.`);
    workers.forEach(w => w.postMessage({ type: 'shutdown' }));
    await waitForWorkersToExit(workers, 1200);
    await flushWalletQueue();
    buildIndex();
    forceGC();
    console.log(`Cycle ${cycleCount} complete. Index rebuilt.`);
    if (!completedCycle || stopRequested()) {
      console.log('Stop flag detected after cycle. Exiting repeat mode.');
      await gracefulShutdown();
      return;
    }
    // === SMART THERMAL COOLDOWN ===
    const pressureAfterCycle = getThermalPressure();
    console.log(`Post-cycle thermal pressure: ${pressureAfterCycle}`);
    if (thermalAtOrAbove(pressureAfterCycle, triggerLevel)) {
      console.log(`Post-cycle pressure is ${pressureAfterCycle} (>= ${triggerLevel}) - extending cooldown before break.`);
      await coolDownUntilSafe(coolToLevel, 20000, 15);
    } else {
      console.log(`BREAK STARTED - Waiting ${cycleMinutes} minutes before next run...`);
    }
    const completedBreak = await sleepWithStop(cycleMinutes * 60 * 1000, 1000);
    if (!completedBreak || stopRequested()) {
      console.log('Stop flag detected during break. Exiting repeat mode.');
      await gracefulShutdown();
      return;
    }
    const pressureBeforeNextCycle = getThermalPressure();
    if (thermalAtOrAbove(pressureBeforeNextCycle, triggerLevel)) {
      console.log(`Still hot before next cycle (${pressureBeforeNextCycle}). Cooling down further before restart...`);
      await coolDownUntilSafe(coolToLevel, 20000, 15);
    }
    console.log(`Break finished for cycle ${cycleCount}. Starting next generation cycle...`);
  }
}
// Mode handlers
if (MODE === 'migrate') {
  runMigration();
  process.exit(0);
}
if (MODE === 'cleanup') {
  runCleanup();
  process.exit(0);
}
if (MODE === 'reindex-matches') {
  runReindexMatches();
  process.exit(0);
}
if (MODE === 'balances' || MODE === 'check-balances') {
  checkAllBalances().then(() => process.exit(0));
  return;
}
if (MODE === 'index') {
  ensureDirs();
  buildIndex();
  process.exit(0);
}
if (MODE === 'list' || MODE === 'search') {
  ensureDirs();
  let minLength = 3;
  let typeFilter = null;
  let minSideLength = 2;
  let searchTerm = '';
  let isSearchMode = MODE === 'search';
  let rawArgs = process.argv.slice(3);
  if (isSearchMode) {
    if (rawArgs.length === 0) {
      console.error('Missing search word.\nUsage: node vanity-generator.js search <word|\"word1 word2\"> [minLength] [start|end|both|single|addition]');
      process.exit(1);
    }
    const working = [...rawArgs];
    if (working.length > 1) {
      const maybeType = working[working.length - 1].toLowerCase();
      if (['start', 'end', 'both', 'single', 'addition'].includes(maybeType)) {
        typeFilter = maybeType;
        working.pop();
      }
    }
    if (working.length > 1) {
      const maybeMin = parseInt(working[working.length - 1], 10);
      if (!isNaN(maybeMin) && maybeMin >= 2) {
        minLength = maybeMin;
        working.pop();
      }
    }
    searchTerm = working.join(' ').toLowerCase().trim();
    if (!searchTerm) {
      console.error('Missing search word.\nUsage: node vanity-generator.js search <word|\"word1 word2\"> [minLength] [start|end|both|single|addition]');
      process.exit(1);
    }
  } else {
    if (rawArgs.length > 0) {
      const lastArg = rawArgs[rawArgs.length - 1].toLowerCase();
      if (['start', 'end', 'both', 'single', 'addition'].includes(lastArg)) {
        typeFilter = lastArg;
        rawArgs.pop();
      }
    }
    if (rawArgs.length > 0) {
      const num = parseInt(rawArgs[0], 10);
      if (!isNaN(num) && num >= 2) minLength = num;
    }
  }
  const storageResult = storageGetFilteredWallets(
    minLength,
    typeFilter,
    isSearchMode ? searchTerm : '',
    Infinity,
    minSideLength,
    false,
    'all',
    'all',
    'all',
    true,
    0,
    false
  );
  let filteredWallets = Array.isArray(storageResult)
    ? storageResult
    : (Array.isArray(storageResult?.wallets) ? storageResult.wallets : []);
  filteredWallets.sort((a, b) => {
    if (a.folder === 'both' && b.folder !== 'both') return -1;
    if (b.folder === 'both' && a.folder !== 'both') return 1;
    return b.matchLen - a.matchLen;
  });
  const tableData = filteredWallets.map((w, index) => {
    const displayLength = (w.startLen > 0 && w.endLen > 0)
      ? `${w.startLen}+${w.endLen}`
      : `${w.startLen || w.endLen}`;
    const pubShort = w.publicKey.slice(0, 10) + '...' + w.publicKey.slice(-10);
    return {
      Rank: (index + 1).toString().padStart(3),
      Type: w.folder.toUpperCase(),
      Start: w.startMatch || '-',
      End: w.endMatch || '-',
      Length: displayLength,
      Rarity: w.matchLen >= 7 ? 'SUPER RARE' : w.matchLen >= 5 ? 'RARE' : w.matchLen >= 4 ? 'GOOD' : 'COMMON',
      'Public Key': pubShort,
      File: path.basename(w.filePath)
    };
  });
  console.table(tableData);
  const jsonBaseName = isSearchMode ? `novelty_search_${searchTerm}` : `novelty_list`;
  const jsonFileName = `${jsonBaseName}${typeFilter ? '_' + typeFilter : ''}_${minLength}.json`;
  const jsonPath = path.join(BASE_DIR, jsonFileName);
  const exportData = {
    generatedAt: new Date().toISOString(),
    mode: MODE,
    totalRegistered: loadOrBuildIndex().totalWallets,
    minLengthFilter: minLength,
    typeFilter: typeFilter || 'all',
    searchTerm: isSearchMode ? searchTerm : null,
    filteredShown: filteredWallets.length,
    wallets: filteredWallets.map((w, index) => {
      const displayLength = (w.startLen > 0 && w.endLen > 0)
        ? `${w.startLen}+${w.endLen}`
        : `${w.startLen || w.endLen}`;
      const pubShort = w.publicKey.slice(0, 10) + '...' + w.publicKey.slice(-10);
      return {
        rank: index + 1,
        folder: w.folder,
        startMatch: w.startMatch || null,
        endMatch: w.endMatch || null,
        startLen: w.startLen,
        endLen: w.endLen,
        totalMatchLength: w.matchLen,
        displayLength: displayLength,
        rarity: w.matchLen >= 7 ? 'SUPER RARE' : w.matchLen >= 5 ? 'RARE' : w.matchLen >= 4 ? 'GOOD' : 'COMMON',
        publicKey: w.publicKey,
        publicKeyShort: pubShort,
        filePath: w.filePath,
        generatedAt: w.generatedAt,
        importTip: `// Wallet in ${path.basename(w.filePath)}`
      };
    })
  };
  fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2));
  console.log(`JSON export created: ${jsonPath}`);
  process.exit(0);
}
// ==================== REPEAT DETECTION FOR GENERATION ====================
const repeatIndex = ALL_ARGS.indexOf('repeat');
let repeatCycleMinutes = null;
if (repeatIndex !== -1 && ALL_ARGS[repeatIndex + 1]) {
  const n = parseInt(ALL_ARGS[repeatIndex + 1]);
  if (!isNaN(n) && n > 0) repeatCycleMinutes = n;
}
if (repeatCycleMinutes !== null) {
  runRepeatingGeneration(repeatCycleMinutes);
  return;
}
// ==================== CONTINUOUS GENERATION WITH MORE RISKY THERMAL PROTECTION ====================
if (isMainThread) {
  ensureDirs();
  clearStopFlag();
  // Invalidate index on new generation
  if (MODE === 'generate' && fs.existsSync(INDEX_PATH)) {
    try {
      fs.unlinkSync(INDEX_PATH);
      console.log('Old index invalidated. Will rebuild when generation session ends.');
    } catch (e) { }
  }
  const numWorkers = Math.min(8, os.cpus().length);
  let workers = [];
  let totalKeys = 0;
  const startTime = Date.now();
  const isAir = isMacBookAir();
  const triggerLevel = 'Serious';
  const coolToLevel = 'Moderate';
  console.log(`Starting ${numWorkers} workers with thermal protection.`);
  console.log(`Detected: ${isAir ? 'MacBook Air (fanless)' : 'MacBook Pro'}`);
  console.log(`Risk level: Allows Moderate → triggers cooldown at ${triggerLevel} → cools to ${coolToLevel}`);
  console.log('Thermal check EVERY 30 seconds (visible).');
  console.log('Press Ctrl+C to stop safely.\n');
  let stopping = false;
  const requestStop = async () => {
    if (stopping) return;
    stopping = true;
    await stopAndIndex();
  };
  function startWorkers() {
    workers = [];
    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(__filename, { workerData: { id: i } });
      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          totalKeys += msg.count;
          const elapsed = (Date.now() - startTime) / 1000;
          if (totalKeys % 500000 === 0) {
            const rate = Math.floor(totalKeys / elapsed);
            console.log(`Progress: ${Math.floor(totalKeys / 1000000)}M keys | ~${rate} keys/sec`);
          }
        } else if (msg.type === 'wallet-found' && msg.wallet) {
          queueWalletForPersistence(msg.wallet);
        }
      });
      workers.push(worker);
    }
  }
  startWorkers();
  // === THERMAL MONITOR (every 30 seconds - ALWAYS logs pressure) ===
  const thermalMonitor = setInterval(async () => {
    if (stopRequested()) {
      console.log('Stop flag detected - graceful shutdown...');
      await requestStop();
      return;
    }
    const pressure = getThermalPressure();
    console.log(`Thermal check: ${pressure}`);
    if (thermalAtOrAbove(pressure, triggerLevel)) {
      console.log(`🔥 Thermal pressure ${pressure} detected - pausing generation to cool down...`);
      workers.forEach(w => w.postMessage({ type: 'pause' }));
      await new Promise(r => setTimeout(r, 1500));
      await coolDownUntilSafe(coolToLevel, 15000, 12);
      console.log('✅ Cooled down - resuming generation...');
      workers.forEach(w => w.postMessage({ type: 'resume' }));
    }
  }, 30000);
  // === STOP & INDEX ===
  const stopAndIndex = async () => {
    clearInterval(thermalMonitor);
    console.log('Graceful shutdown - sending stop signal to workers...');
    workers.forEach(w => {
      if (w) w.postMessage({ type: 'shutdown' });
    });
    await new Promise(r => setTimeout(r, 800));
    console.log('Forcing terminate on any remaining workers...');
    workers.forEach((w) => w && w.terminate());
    await waitForWorkersToExit(workers, 1500);
    await flushWalletQueue();
    buildIndex();
    forceGC();
    console.log('Session finished. All workers stopped cleanly. Index is now ready for fast list/search.');
    process.exit(0);
  };
  if (timerMinutes) {
    setTimeout(async () => {
      console.log(`Timer finished (${timerMinutes} minutes).`);
      await requestStop();
    }, timerMinutes * 60 * 1000);
  }
  process.on('SIGINT', async () => {
    console.log('Stopping gracefully...');
    await requestStop();
  });
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received - graceful shutdown...');
    await requestStop();
  });
  const stopWatcher = setInterval(async () => {
    if (stopRequested()) {
      console.log('Stop flag detected by watcher - shutting down...');
      clearInterval(stopWatcher);
      await requestStop();
    }
  }, 1000);
  process.on('beforeExit', forceGC);
} else {
  // Worker thread - GRACEFUL SHUTDOWN + PAUSE/RESUME SUPPORT
  (async () => {
    const BATCH_SIZE = 40000;
    let batch = 0;
    let running = true;
    let paused = false;
    parentPort.on('message', (msg) => {
      if (msg && msg.type === 'shutdown') running = false;
      if (msg && msg.type === 'pause') paused = true;
      if (msg && msg.type === 'resume') paused = false;
    });
    while (running) {
      while (paused) {
        await new Promise(r => setImmediate(r));
      }
      const kp = Keypair.generate();
      const pubStr = kp.publicKey.toBase58();
      const pubLower = pubStr.toLowerCase();
      const startMatch = findLongestMatch(pubLower, true);
      const endMatch = findLongestMatch(pubLower, false);
      if (startMatch || endMatch) {
        saveWallet(kp, pubStr, startMatch, endMatch);
      }
      batch++;
      if (batch >= BATCH_SIZE) {
        parentPort.postMessage({ type: 'progress', count: BATCH_SIZE });
        batch = 0;
      }
      if (batch % 1000 === 0) {
        await new Promise(r => setImmediate(r));
      }
    }
    parentPort.postMessage({ type: 'shutdown_complete' });
    process.exit(0);
  })();
}
