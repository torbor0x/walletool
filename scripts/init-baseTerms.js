// scripts/init-baseTerms.js
// Generates a starter baseTerms.js in the project root.
// Run with: node scripts/init-baseTerms.js
// Edit the resulting baseTerms.js to add your own terms.

const fs = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '..', 'baseTerms.js');

const DEFAULT_TERMS = [
    // Solana / crypto
    'sol', 'solana', 'crypto', 'defi', 'token', 'wallet', 'nft', 'dao',
    'jup', 'jupiter', 'ray', 'raydium', 'orca', 'phantom', 'backpack',
    'pump', 'bonk', 'pepe', 'doge', 'moon', 'lambo', 'hodl', 'wagmi',
    // Generic positive
    'alpha', 'apex', 'blaze', 'boss', 'chad', 'elite', 'epic', 'forge',
    'gem', 'giga', 'gold', 'king', 'legend', 'lunar', 'max', 'meta',
    'nova', 'prime', 'pro', 'quantum', 'royal', 'solar', 'star', 'super',
    'titan', 'ultra', 'victor', 'vip', 'wizard', 'zen',
    // Meme / fun
    '420', '69', '1337', 'leet', 'kek', 'lol', 'meme', 'based',
    // Tech / space
    'cyber', 'dragon', 'ghost', 'matrix', 'nebula', 'neon', 'orbit', 'phoenix',
    'pulse', 'rocket', 'shadow', 'storm', 'thunder', 'vortex',
];

const HEADER = `// baseTerms.js — vanity wallet search terms.
// This file is gitignored by default to keep your personal terms private.
//
// Rules:
//   - Each term must be Base58-safe: no 0, O, I, or l.
//   - Terms should be at least 3 characters for reliable matching.
//   - The generator automatically expands short terms into leetspeak variants.
//   - Duplicate terms and invalid characters are filtered automatically.
//
// Edit this file and restart the dev server / CLI to pick up changes.

export default [`;

const FOOTER = `];`;

function quote(term) {
    return `    '${term.replace(/'/g, "\\'")}'`;
}

function generateFile(terms) {
    const lines = terms.map(quote);
    return `${HEADER}\n${lines.join(',\n')}\n${FOOTER}\n`;
}

if (fs.existsSync(OUTPUT)) {
    console.log(`baseTerms.js already exists at ${OUTPUT}`);
    console.log('Delete it first if you want to regenerate the starter template.');
    process.exit(0);
}

fs.writeFileSync(OUTPUT, generateFile(DEFAULT_TERMS), 'utf8');
console.log(`Created ${OUTPUT} with ${DEFAULT_TERMS.length} starter terms.`);
console.log('Open the file and add your own terms, then restart the app / CLI.');
