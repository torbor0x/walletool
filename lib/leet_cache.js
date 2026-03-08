const fs = require('fs');
const path = require('path');

const LEET_CACHE_PATH = path.join(__dirname, '..', 'novelty_wallets', 'leet_cache.json');

// Leet speak mapping
const LEET_MAP = { 
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

// In-memory cache for runtime
let leetCache = null;
let cacheLoaded = false;

function loadLeetCache() {
    if (cacheLoaded) return leetCache;
    
    try {
        if (fs.existsSync(LEET_CACHE_PATH)) {
            const cacheData = JSON.parse(fs.readFileSync(LEET_CACHE_PATH, 'utf8'));
            leetCache = new Map(Object.entries(cacheData));
            console.log(`Loaded leet cache with ${leetCache.size} entries`);
        } else {
            leetCache = new Map();
            console.log('No leet cache found, starting fresh');
        }
    } catch (e) {
        console.warn('Failed to load leet cache:', e.message);
        leetCache = new Map();
    }
    
    cacheLoaded = true;
    return leetCache;
}

function saveLeetCache() {
    if (!leetCache) return;
    
    try {
        const cacheObj = Object.fromEntries(leetCache);
        fs.writeFileSync(LEET_CACHE_PATH, JSON.stringify(cacheObj, null, 2));
        console.log(`Saved leet cache with ${leetCache.size} entries`);
    } catch (e) {
        console.warn('Failed to save leet cache:', e.message);
    }
}

// Generate leet variants with caching
function generateLeetVariants(word) {
    if (!word || typeof word !== 'string' || word.length === 0) {
        return new Set();
    }
    
    const cache = loadLeetCache();
    const cacheKey = word.toLowerCase();
    
    if (cache.has(cacheKey)) {
        return new Set(cache.get(cacheKey));
    }
    
    // Generate variants if not in cache
    const lowerWord = word.toLowerCase();
    const variants = new Set();
    
    function recurse(index, current) {
        if (index === lowerWord.length) {
            variants.add(current);
            return;
        }
        const char = lowerWord[index];
        const options = LEET_MAP[char] || [char];
        for (let opt of options) recurse(index + 1, current + opt);
    }
    
    recurse(0, '');
    
    // Cache the result (limit cache size to prevent memory issues)
    if (cache.size < 10000) {
        cache.set(cacheKey, Array.from(variants));
    }
    
    return variants;
}

// Pre-generate common variants to warm up cache
function warmupCache() {
    console.log('Warming up leet cache with common terms...');
    const commonTerms = [
        'peach', 'tor', 'get', 'kyke', 'sol', 'eth', 'btc', 'usd',
        'moon', 'star', 'sun', 'love', 'hate', 'god', 'devil',
        'cat', 'dog', 'fish', 'bird', 'car', 'house', 'home',
        'one', 'two', 'three', 'four', 'five', 'six', 'seven',
        'eight', 'nine', 'ten', 'hundred', 'thousand', 'million'
    ];
    
    const cache = loadLeetCache();
    let newEntries = 0;
    
    for (const term of commonTerms) {
        if (!cache.has(term.toLowerCase())) {
            const variants = generateLeetVariants(term);
            cache.set(term.toLowerCase(), Array.from(variants));
            newEntries++;
        }
    }
    
    if (newEntries > 0) {
        saveLeetCache();
        console.log(`Added ${newEntries} new entries to leet cache`);
    }
}

// Batch generate variants for multiple words
function generateBatchVariants(words) {
    const cache = loadLeetCache();
    const results = new Map();
    const toGenerate = [];
    
    // Check cache first
    for (const word of words) {
        const cacheKey = word.toLowerCase();
        if (cache.has(cacheKey)) {
            results.set(word, new Set(cache.get(cacheKey)));
        } else {
            toGenerate.push(word);
        }
    }
    
    // Generate missing variants
    for (const word of toGenerate) {
        const variants = generateLeetVariants(word);
        results.set(word, variants);
    }
    
    return results;
}

// Get cache statistics
function getCacheStats() {
    const cache = loadLeetCache();
    const stats = {
        size: cache.size,
        memoryUsage: 0,
        hitRate: 0
    };
    
    // Estimate memory usage
    for (const [word, variants] of cache) {
        stats.memoryUsage += word.length * 2; // word chars
        stats.memoryUsage += variants.length * 2; // variant chars
    }
    
    return stats;
}

// Clear cache (useful for testing or if cache gets corrupted)
function clearCache() {
    leetCache = new Map();
    cacheLoaded = false;
    try {
        if (fs.existsSync(LEET_CACHE_PATH)) {
            fs.unlinkSync(LEET_CACHE_PATH);
        }
    } catch (e) {
        console.warn('Failed to delete leet cache file:', e.message);
    }
    console.log('Leet cache cleared');
}

module.exports = {
    generateLeetVariants,
    generateBatchVariants,
    warmupCache,
    getCacheStats,
    clearCache,
    saveLeetCache,
    loadLeetCache
};
