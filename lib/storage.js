const fs = require('fs');
const path = require('path');

const BASE_DIR = 'novelty_wallets';
const FOLDERS = ['start', 'end', 'both'];
const DB_PATHS = {
    start: path.join(BASE_DIR, 'start', 'start_wallets.jsonl'),
    end: path.join(BASE_DIR, 'end', 'end_wallets.jsonl'),
    both: path.join(BASE_DIR, 'both', 'both_wallets.jsonl')
};
const INDEX_PATH = path.join(BASE_DIR, 'novelty_index.json');
const EXPORTED_PATH = path.join(BASE_DIR, 'exported_wallets.jsonl');
const ARCHIVED_PATH = path.join(BASE_DIR, 'archived_wallets.jsonl');
const EXPORTED_RECORDS_INDEX_PATH = path.join(BASE_DIR, 'exported_wallet_records_index.json');
const JSONL_CHUNK_SIZE = 1024 * 1024; // 1MB chunks keep memory usage stable on very large files.
const SEARCH_RESULT_CACHE_MAX = 50;

const searchCriteriaCache = new Map();
const filteredWalletsCache = new Map();
let exportedWalletSetCache = { mtimeMs: null, set: new Set() };
let archivedWalletMapCache = { mtimeMs: null, map: new Map() };
let exportedWalletRecordsCache = { key: null, records: [] };

function ensureDirs() {
    if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });
    FOLDERS.forEach(folder => {
        const dir = path.join(BASE_DIR, folder);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

function forEachJsonlLineSync(filePath, onLine) {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(JSONL_CHUNK_SIZE);
    let leftover = '';
    let shouldContinue = true;
    try {
        while (shouldContinue) {
            const bytesRead = fs.readSync(fd, buffer, 0, JSONL_CHUNK_SIZE, null);
            if (bytesRead <= 0) break;
            const chunk = leftover + buffer.toString('utf8', 0, bytesRead);
            const lines = chunk.split('\n');
            leftover = lines.pop() || '';
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) continue;
                if (onLine(line) === false) {
                    shouldContinue = false;
                    break;
                }
            }
        }
        if (shouldContinue) {
            const line = leftover.trim();
            if (line) onLine(line);
        }
    } finally {
        fs.closeSync(fd);
    }
}

function buildIndex() {
    ensureDirs();
    let totalWallets = 0;
    const byFolder = { start: 0, end: 0, both: 0 };
    FOLDERS.forEach((folder) => {
        const jsonlPath = DB_PATHS[folder];
        if (!fs.existsSync(jsonlPath)) {
            byFolder[folder] = 0;
            return;
        }
        try {
            let count = 0;
            forEachJsonlLineSync(jsonlPath, () => {
                count += 1;
                return true;
            });
            byFolder[folder] = count;
            totalWallets += count;
        } catch (e) {
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
    } catch (e) {
        // Index metadata is best-effort; continue serving computed data.
    }
    return indexData;
}

function loadOrBuildIndex() {
    if (fs.existsSync(INDEX_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
        } catch (e) { }
    }
    return buildIndex();
}

function getFileMtimeMs(filePath) {
    try {
        if (!fs.existsSync(filePath)) return 0;
        return fs.statSync(filePath).mtimeMs || 0;
    } catch (e) {
        return 0;
    }
}

function getDataVersionToken() {
    const parts = [getFileMtimeMs(EXPORTED_PATH), getFileMtimeMs(ARCHIVED_PATH)];
    for (const folder of FOLDERS) {
        parts.push(getFileMtimeMs(DB_PATHS[folder]));
    }
    return parts.join('|');
}

function getWalletDbVersionToken() {
    const parts = [];
    for (const folder of FOLDERS) {
        parts.push(getFileMtimeMs(DB_PATHS[folder]));
    }
    return parts.join('|');
}

function addToBoundedCache(cache, key, value, maxEntries) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    if (cache.size <= maxEntries) return;
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
}

function matchesTypeFilter(typeFilter, folder, startLen, endLen, minSideLength = 2) {
    if (!typeFilter || typeFilter === 'all') return true;
    if (typeFilter === 'start' || typeFilter === 'end' || typeFilter === 'both') {
        return folder === typeFilter;
    }
    if (typeFilter === 'single') {
        return (startLen > 0 && endLen === 0) || (endLen > 0 && startLen === 0);
    }
    if (typeFilter === 'addition') {
        return startLen >= minSideLength && endLen >= minSideLength;
    }
    return true;
}

function getRelevantFolders(typeFilter) {
    if (typeFilter === 'start' || typeFilter === 'end' || typeFilter === 'both') {
        return [typeFilter];
    }
    if (typeFilter === 'single') return ['start', 'end'];
    if (typeFilter === 'addition') return ['both'];
    return FOLDERS;
}

function buildSearchCriteria(searchInput = '') {
    const input = (searchInput || '').trim().toLowerCase();
    if (!input) return { mode: 'none', variants: [] };
    if (searchCriteriaCache.has(input)) return searchCriteriaCache.get(input);
    const parts = input.split(/[,\s+]+/).filter(Boolean);
    const map = { a: ['a', '4'], b: ['b', '8'], e: ['e', '3'], g: ['g', '9', '6'], i: ['i', '1'], l: ['l', '1'], s: ['s', '5'], t: ['t', '7'], z: ['z', '2'] };
    if (parts.length >= 2) {
        const words = [parts[0], parts[1]];
        const toVariants = (word) => {
            const out = new Set();
            function recurse(idx, cur) {
                if (idx === word.length) { out.add(cur.toUpperCase()); return; }
                const ch = word[idx];
                const opts = map[ch] || [ch];
                for (const o of opts) recurse(idx + 1, cur + o);
            }
            recurse(0, '');
            return out;
        };
        const pairCriteria = { mode: 'pair', first: toVariants(words[0]), second: toVariants(words[1]) };
        addToBoundedCache(searchCriteriaCache, input, pairCriteria, SEARCH_RESULT_CACHE_MAX);
        return pairCriteria;
    }
    const word = parts[0];
    const variants = new Set();
    function recurse(idx, cur) {
        if (idx === word.length) { variants.add(cur.toUpperCase()); return; }
        const ch = word[idx];
        const opts = map[ch] || [ch];
        for (const o of opts) recurse(idx + 1, cur + o);
    }
    recurse(0, '');
    const singleCriteria = { mode: 'single', variants };
    addToBoundedCache(searchCriteriaCache, input, singleCriteria, SEARCH_RESULT_CACHE_MAX);
    return singleCriteria;
}

function hasDigit(value) {
    return /\d/.test(value || '');
}

function getExportedWalletSet() {
    const exportedMtime = getFileMtimeMs(EXPORTED_PATH);
    if (exportedWalletSetCache.mtimeMs === exportedMtime) return exportedWalletSetCache.set;
    const exported = new Set();
    if (!fs.existsSync(EXPORTED_PATH)) {
        exportedWalletSetCache = { mtimeMs: exportedMtime, set: exported };
        return exported;
    }
    try {
        forEachJsonlLineSync(EXPORTED_PATH, (line) => {
            try {
                const parsed = JSON.parse(line);
                if (parsed && typeof parsed.publicKey === 'string' && parsed.publicKey.trim()) {
                    exported.add(parsed.publicKey.trim());
                }
            } catch (e) { }
            return true;
        });
    } catch (e) { }
    exportedWalletSetCache = { mtimeMs: exportedMtime, set: exported };
    return exported;
}

function markWalletsExported(publicKeys = []) {
    const uniquePubkeys = Array.from(new Set(
        (Array.isArray(publicKeys) ? publicKeys : [])
            .filter((p) => typeof p === 'string')
            .map((p) => p.trim())
            .filter(Boolean)
    ));
    if (uniquePubkeys.length === 0) {
        return { marked: 0, alreadyExported: 0, requested: 0 };
    }
    ensureDirs();
    const existing = getExportedWalletSet();
    const toAppend = [];
    let alreadyExported = 0;
    uniquePubkeys.forEach((pubkey) => {
        if (existing.has(pubkey)) {
            alreadyExported += 1;
            return;
        }
        toAppend.push(JSON.stringify({ publicKey: pubkey, exportedAt: new Date().toISOString() }));
    });
    if (toAppend.length > 0) {
        fs.appendFileSync(EXPORTED_PATH, `${toAppend.join('\n')}\n`);
        exportedWalletRecordsCache = { key: null, records: [] };
        try { if (fs.existsSync(EXPORTED_RECORDS_INDEX_PATH)) fs.unlinkSync(EXPORTED_RECORDS_INDEX_PATH); } catch (e) { }
    }
    return {
        marked: toAppend.length,
        alreadyExported,
        requested: uniquePubkeys.length
    };
}

function getArchivedWalletMap() {
    const archivedMtime = getFileMtimeMs(ARCHIVED_PATH);
    if (archivedWalletMapCache.mtimeMs === archivedMtime) return archivedWalletMapCache.map;
    const archived = new Map();
    if (!fs.existsSync(ARCHIVED_PATH)) {
        archivedWalletMapCache = { mtimeMs: archivedMtime, map: archived };
        return archived;
    }
    try {
        forEachJsonlLineSync(ARCHIVED_PATH, (line) => {
            try {
                const parsed = JSON.parse(line);
                const publicKey = typeof parsed?.publicKey === 'string' ? parsed.publicKey.trim() : '';
                if (!publicKey) return true;
                archived.set(publicKey, {
                    archivedAt: typeof parsed.archivedAt === 'string' ? parsed.archivedAt : null,
                    note: typeof parsed.note === 'string' ? parsed.note : ''
                });
            } catch (e) { }
            return true;
        });
    } catch (e) { }
    archivedWalletMapCache = { mtimeMs: archivedMtime, map: archived };
    return archived;
}

function markWalletsArchived(entries = []) {
    const normalized = new Map();
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
        const publicKey = typeof entry?.publicKey === 'string' ? entry.publicKey.trim() : '';
        if (!publicKey) return;
        const note = typeof entry?.note === 'string' ? entry.note.trim() : '';
        normalized.set(publicKey, note);
    });
    const uniqueEntries = Array.from(normalized.entries()).map(([publicKey, note]) => ({ publicKey, note }));
    if (uniqueEntries.length === 0) {
        return { archived: 0, updated: 0, unchanged: 0, skippedNotExported: 0, requested: 0 };
    }

    ensureDirs();
    const exportedSet = getExportedWalletSet();
    const archivedMap = getArchivedWalletMap();
    const toAppend = [];
    let archived = 0;
    let updated = 0;
    let unchanged = 0;
    let skippedNotExported = 0;

    uniqueEntries.forEach(({ publicKey, note }) => {
        if (!exportedSet.has(publicKey)) {
            skippedNotExported += 1;
            return;
        }
        const previous = archivedMap.get(publicKey);
        if (previous && previous.note === note) {
            unchanged += 1;
            return;
        }
        const archivedAt = new Date().toISOString();
        toAppend.push(JSON.stringify({ publicKey, archivedAt, note }));
        if (previous) updated += 1;
        else archived += 1;
    });

    if (toAppend.length > 0) {
        fs.appendFileSync(ARCHIVED_PATH, `${toAppend.join('\n')}\n`);
    }

    return {
        archived,
        updated,
        unchanged,
        skippedNotExported,
        requested: uniqueEntries.length
    };
}

function getExportedWalletRecords() {
    const exportedSet = getExportedWalletSet();
    if (exportedSet.size === 0) return [];
    const cacheKey = `${getWalletDbVersionToken()}|${getFileMtimeMs(EXPORTED_PATH)}`;
    if (exportedWalletRecordsCache.key === cacheKey) return exportedWalletRecordsCache.records;
    try {
        if (fs.existsSync(EXPORTED_RECORDS_INDEX_PATH)) {
            const indexPayload = JSON.parse(fs.readFileSync(EXPORTED_RECORDS_INDEX_PATH, 'utf8'));
            if (indexPayload?.key === cacheKey && Array.isArray(indexPayload?.records)) {
                exportedWalletRecordsCache = { key: cacheKey, records: indexPayload.records };
                return indexPayload.records;
            }
        }
    } catch (e) { }

    const records = [];
    const found = new Set();

    for (const folder of FOLDERS) {
        if (found.size >= exportedSet.size) break;
        const jsonlPath = DB_PATHS[folder];
        if (!fs.existsSync(jsonlPath)) continue;
        try {
            forEachJsonlLineSync(jsonlPath, (line) => {
                if (found.size >= exportedSet.size) return false;
                try {
                    const data = JSON.parse(line);
                    const publicKey = typeof data?.publicKey === 'string' ? data.publicKey : '';
                    if (!publicKey || !exportedSet.has(publicKey) || found.has(publicKey)) return true;
                    const startMatch = data.startMatch || '';
                    const endMatch = data.endMatch || '';
                    const startLen = startMatch.length;
                    const endLen = endMatch.length;
                    records.push({
                        publicKey,
                        generatedAt: data.generatedAt || null,
                        folder,
                        startMatch,
                        endMatch,
                        startLen,
                        endLen,
                        matchLen: startLen + endLen,
                        vanityDisplay: startMatch && endMatch
                            ? `${startMatch}...${endMatch}`
                            : startMatch
                                ? `${startMatch}...${publicKey.slice(-4)}`
                                : `${publicKey.slice(0, 4)}...${endMatch}`
                    });
                    found.add(publicKey);
                } catch (e) { }
                return true;
            });
        } catch (e) { }
    }

    exportedWalletRecordsCache = { key: cacheKey, records };
    try {
        fs.writeFileSync(EXPORTED_RECORDS_INDEX_PATH, JSON.stringify({ key: cacheKey, records }));
    } catch (e) { }
    return records;
}

function getWalletPrivateKeys(publicKeys = []) {
    const requested = new Set(
        (Array.isArray(publicKeys) ? publicKeys : [])
            .filter((p) => typeof p === 'string')
            .map((p) => p.trim())
            .filter(Boolean)
    );
    if (requested.size === 0) {
        return { wallets: [], found: 0, requested: 0 };
    }

    const found = new Map();
    for (const folder of FOLDERS) {
        if (found.size >= requested.size) break;
        const jsonlPath = DB_PATHS[folder];
        if (!fs.existsSync(jsonlPath)) continue;
        try {
            forEachJsonlLineSync(jsonlPath, (line) => {
                if (found.size >= requested.size) return false;
                try {
                    const data = JSON.parse(line);
                    const publicKey = typeof data?.publicKey === 'string' ? data.publicKey : '';
                    if (!publicKey || !requested.has(publicKey) || found.has(publicKey)) return true;
                    const privateKey = data.secretKeyBase64
                        ? data.secretKeyBase64
                        : Array.isArray(data.secretKey)
                            ? Buffer.from(Uint8Array.from(data.secretKey)).toString('base64')
                            : null;
                    found.set(publicKey, privateKey);
                } catch (e) { }
                return true;
            });
        } catch (e) { }
    }

    return {
        wallets: Array.from(found.entries()).map(([publicKey, privateKey]) => ({ publicKey, privateKey })),
        found: found.size,
        requested: requested.size
    };
}

function getFilteredWallets(minLength = 3, typeFilter = null, searchInput = '', maxResults = Infinity, minSideLength = 2, includePrivateKeys = false, exportedFilter = 'all', nameStyleFilter = 'all', archivedFilter = 'not-archived') {
    const limit = Number.isFinite(maxResults) ? Math.max(1, Math.floor(maxResults)) : Infinity;
    const sideMin = Number.isFinite(minSideLength) ? Math.max(1, Math.floor(minSideLength)) : 2;
    const searchCriteria = buildSearchCriteria(searchInput);
    const foldersToScan = getRelevantFolders(typeFilter);
    const cacheKey = JSON.stringify({
        minLength,
        typeFilter: typeFilter || 'all',
        searchInput: (searchInput || '').trim().toLowerCase(),
        limit,
        minSideLength: sideMin,
        includePrivateKeys: !!includePrivateKeys,
        exportedFilter: exportedFilter || 'all',
        nameStyleFilter: nameStyleFilter || 'all',
        archivedFilter: archivedFilter || 'not-archived',
        foldersToScan,
        dataVersion: getDataVersionToken()
    });
    if (filteredWalletsCache.has(cacheKey)) {
        const cached = filteredWalletsCache.get(cacheKey);
        filteredWalletsCache.delete(cacheKey);
        filteredWalletsCache.set(cacheKey, cached);
        return cached;
    }

    const filtered = [];
    const exportedSet = getExportedWalletSet();
    const archivedMap = getArchivedWalletMap();
    if (exportedFilter === 'exported') {
        const exportedRecords = getExportedWalletRecords();
        for (const data of exportedRecords) {
            if (filtered.length >= limit) break;
            const sLen = data.startLen || 0;
            const eLen = data.endLen || 0;
            if (!matchesTypeFilter(typeFilter, data.folder, sLen, eLen, sideMin)) continue;
            const matchLen = data.matchLen || (sLen + eLen);
            if (matchLen < minLength) continue;
            const startMatch = data.startMatch || '';
            const endMatch = data.endMatch || '';
            if (nameStyleFilter === 'letters-only' && (hasDigit(startMatch) || hasDigit(endMatch))) continue;
            const archivedMeta = archivedMap.get(data.publicKey) || null;
            const isArchived = !!archivedMeta;
            if (archivedFilter === 'archived' && !isArchived) continue;
            if (archivedFilter === 'not-archived' && isArchived) continue;
            let matchesSearch = true;
            const s = startMatch.toUpperCase();
            const e = endMatch.toUpperCase();
            if (searchCriteria.mode === 'single') {
                matchesSearch = searchCriteria.variants.has(s) || searchCriteria.variants.has(e);
            } else if (searchCriteria.mode === 'pair') {
                const firstOnStartSecondOnEnd = searchCriteria.first.has(s) && searchCriteria.second.has(e);
                const secondOnStartFirstOnEnd = searchCriteria.second.has(s) && searchCriteria.first.has(e);
                matchesSearch = firstOnStartSecondOnEnd || secondOnStartFirstOnEnd;
            }
            if (!matchesSearch) continue;
            filtered.push({
                publicKey: data.publicKey,
                privateKey: null,
                isExported: true,
                isArchived,
                archivedAt: archivedMeta?.archivedAt || null,
                archivedNote: archivedMeta?.note || '',
                startMatch: startMatch || null,
                endMatch: endMatch || null,
                generatedAt: data.generatedAt,
                folder: data.folder,
                startLen: sLen,
                endLen: eLen,
                matchLen,
                vanityDisplay: data.vanityDisplay
            });
        }
        addToBoundedCache(filteredWalletsCache, cacheKey, filtered, SEARCH_RESULT_CACHE_MAX);
        return filtered;
    }
    let reachedLimit = false;

    for (const folder of foldersToScan) {
        if (reachedLimit) break;
        const jsonlPath = DB_PATHS[folder];
        if (!fs.existsSync(jsonlPath)) continue;
        try {
            forEachJsonlLineSync(jsonlPath, (line) => {
                try {
                    const data = JSON.parse(line);
                    const sLen = data.startMatch ? data.startMatch.length : 0;
                    const eLen = data.endMatch ? data.endMatch.length : 0;
                    if (!matchesTypeFilter(typeFilter, folder, sLen, eLen, sideMin)) return true;
                    const matchLen = sLen + eLen;
                    if (matchLen < minLength) return true;
                    const startMatch = data.startMatch || '';
                    const endMatch = data.endMatch || '';
                    if (nameStyleFilter === 'letters-only' && (hasDigit(startMatch) || hasDigit(endMatch))) return true;
                    const isExported = exportedSet.has(data.publicKey);
                    const archivedMeta = archivedMap.get(data.publicKey) || null;
                    const isArchived = !!archivedMeta;
                    if (exportedFilter === 'exported' && !isExported) return true;
                    if (exportedFilter === 'not-exported' && isExported) return true;
                    if (archivedFilter === 'archived' && !isArchived) return true;
                    if (archivedFilter === 'not-archived' && isArchived) return true;
                    let matchesSearch = true;
                    const s = startMatch.toUpperCase();
                    const e = endMatch.toUpperCase();
                    if (searchCriteria.mode === 'single') {
                        matchesSearch = searchCriteria.variants.has(s) || searchCriteria.variants.has(e);
                    } else if (searchCriteria.mode === 'pair') {
                        const firstOnStartSecondOnEnd = searchCriteria.first.has(s) && searchCriteria.second.has(e);
                        const secondOnStartFirstOnEnd = searchCriteria.second.has(s) && searchCriteria.first.has(e);
                        matchesSearch = firstOnStartSecondOnEnd || secondOnStartFirstOnEnd;
                    }
                    if (matchesSearch) {
                        filtered.push({
                            publicKey: data.publicKey,
                            privateKey: null,
                            isExported,
                            isArchived,
                            archivedAt: archivedMeta?.archivedAt || null,
                            archivedNote: archivedMeta?.note || '',
                            startMatch: startMatch || null,
                            endMatch: endMatch || null,
                            generatedAt: data.generatedAt,
                            folder: folder,
                            startLen: sLen,
                            endLen: eLen,
                            matchLen: matchLen,
                            vanityDisplay: startMatch && endMatch
                                ? `${startMatch}...${endMatch}`
                                : startMatch
                                    ? `${startMatch}...${data.publicKey.slice(-4)}`
                                    : `${data.publicKey.slice(0, 4)}...${endMatch}`
                        });
                        if (filtered.length >= limit) {
                            reachedLimit = true;
                            return false;
                        }
                    }
                } catch (e) { }
                return true;
            });
        } catch (e) { }
    }
    addToBoundedCache(filteredWalletsCache, cacheKey, filtered, SEARCH_RESULT_CACHE_MAX);
    return filtered;
}

function classifyRarity(startLen, endLen) {
    const sLen = startLen || 0;
    const eLen = endLen || 0;
    const matchLen = sLen + eLen;

    if (sLen > 0 && eLen > 0) {
        if (sLen >= 8 || eLen >= 8 || (sLen >= 5 && eLen >= 5)) return 'ultra';
        if (sLen >= 7 || eLen >= 7 || (sLen >= 4 && eLen >= 5)) return 'epic';
        if (sLen >= 6 || eLen >= 6 || (sLen >= 3 && eLen >= 4)) return 'rare';
    } else if (sLen > 0) {
        if (sLen >= 8) return 'ultra';
        if (sLen >= 7) return 'epic';
        if (sLen >= 6) return 'rare';
    } else if (eLen > 0) {
        if (eLen >= 8) return 'ultra';
        if (eLen >= 7) return 'epic';
        if (eLen >= 6) return 'rare';
    }

    if (matchLen >= 4) return 'good';
    return 'common';
}

function getWalletStats() {
    const stats = {
        generatedAt: new Date().toISOString(),
        totalWallets: 0,
        byFolder: { start: 0, end: 0, both: 0 },
        rarity: {
            superRare: 0,
            ultraRare: 0,
            epic: 0,
            rare: 0,
            good: 0,
            common: 0
        },
        lengths: {
            average: 0,
            maxTotal: 0,
            maxStart: 0,
            maxEnd: 0
        },
        recent: {
            last24h: 0
        },
        topExample: null
    };

    const now = Date.now();
    const dayAgo = now - (24 * 60 * 60 * 1000);
    let sumMatchLen = 0;

    for (const folder of FOLDERS) {
        const jsonlPath = DB_PATHS[folder];
        if (!fs.existsSync(jsonlPath)) continue;
        try {
            forEachJsonlLineSync(jsonlPath, (line) => {
                try {
                    const data = JSON.parse(line);
                    const startLen = data.startMatch ? data.startMatch.length : 0;
                    const endLen = data.endMatch ? data.endMatch.length : 0;
                    const matchLen = startLen + endLen;
                    const tier = classifyRarity(startLen, endLen);

                    stats.totalWallets += 1;
                    stats.byFolder[folder] += 1;
                    stats.lengths.maxTotal = Math.max(stats.lengths.maxTotal, matchLen);
                    stats.lengths.maxStart = Math.max(stats.lengths.maxStart, startLen);
                    stats.lengths.maxEnd = Math.max(stats.lengths.maxEnd, endLen);
                    sumMatchLen += matchLen;

                    if (tier === 'ultra') stats.rarity.ultraRare += 1;
                    else if (tier === 'epic') stats.rarity.epic += 1;
                    else if (tier === 'rare') stats.rarity.rare += 1;
                    else if (tier === 'good') stats.rarity.good += 1;
                    else stats.rarity.common += 1;

                    if (data.generatedAt) {
                        const ts = Date.parse(data.generatedAt);
                        if (!Number.isNaN(ts) && ts >= dayAgo) stats.recent.last24h += 1;
                    }

                    if (!stats.topExample || matchLen > stats.topExample.matchLen) {
                        stats.topExample = {
                            publicKey: data.publicKey,
                            startMatch: data.startMatch || '',
                            endMatch: data.endMatch || '',
                            matchLen,
                            type: folder,
                            generatedAt: data.generatedAt || null
                        };
                    }
                } catch (e) { }
                return true;
            });
        } catch (e) { }
    }

    stats.rarity.superRare = stats.rarity.ultraRare + stats.rarity.epic;
    stats.lengths.average = stats.totalWallets > 0 ? Number((sumMatchLen / stats.totalWallets).toFixed(2)) : 0;
    return stats;
}

module.exports = {
    buildIndex,
    loadOrBuildIndex,
    getFilteredWallets,
    getWalletPrivateKeys,
    getWalletStats,
    markWalletsExported,
    markWalletsArchived
};
