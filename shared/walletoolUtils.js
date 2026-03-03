// shared/walletoolUtils.js
const path = require('path');
const baseTerms = require(path.resolve(__dirname, '../baseTerms'));

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
        .filter((v) => isValidBase58(v) && v.length >= 3);
}

let allTargets = [];
baseTerms.forEach((term) => {
    allTargets.push(...generateLeetVariants(term));
});
const targets = [...new Set(allTargets)].sort((a, b) => b.length - a.length);

function findLongestMatch(pubLower, isPrefix) {
    for (let t of targets) {
        if (isPrefix ? pubLower.startsWith(t) : pubLower.endsWith(t)) {
            return t;
        }
    }
    return '';
}

function calculateDisplayAndRarity(startMatch, endMatch, pubStr) {
    const sLen = startMatch ? startMatch.length : 0;
    const eLen = endMatch ? endMatch.length : 0;
    let display = '';
    let rarity = '';
    const startUpper = startMatch ? startMatch.toUpperCase() : '';
    const endUpper = endMatch ? endMatch.toUpperCase() : '';
    if (startMatch && endMatch) {
        display = `${startUpper}...${endUpper}`;
        if (sLen >= 8 || eLen >= 8 || (sLen >= 5 && eLen >= 5)) rarity = '🔥🔥🔥🔥🔥 ULTRA RARE';
        else if (sLen >= 7 || eLen >= 7 || (sLen >= 4 && eLen >= 5)) rarity = '🔥🔥🔥 EPIC';
        else if (sLen >= 6 || eLen >= 6 || (sLen >= 3 && eLen >= 4)) rarity = '🔥🔥 RARE';
    } else if (startMatch) {
        display = `${startUpper}...${pubStr.slice(-4).toUpperCase()}`;
        if (sLen >= 8) rarity = '🔥🔥🔥🔥🔥 ULTRA RARE';
        else if (sLen >= 7) rarity = '🔥🔥🔥 EPIC';
        else if (sLen >= 6) rarity = '🔥🔥 RARE';
    } else if (endMatch) {
        display = `${pubStr.slice(0, 4).toUpperCase()}...${endUpper}`;
        if (eLen >= 8) rarity = '🔥🔥🔥🔥🔥 ULTRA RARE';
        else if (eLen >= 7) rarity = '🔥🔥🔥 EPIC';
        else if (eLen >= 6) rarity = '🔥🔥 RARE';
    }
    return { display, rarity };
}

const secretKeyToBase64 = (secretKey) => Buffer.from(secretKey).toString('base64');

module.exports = {
    targets,
    findLongestMatch,
    calculateDisplayAndRarity,
    secretKeyToBase64,
    generateLeetVariants
};