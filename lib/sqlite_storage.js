const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { generateLeetVariants } = require('./leet_cache');

const BASE_DIR = 'novelty_wallets';
const SQLITE_DB_PATH = path.join(BASE_DIR, 'wallets.db');
const EXPORTED_PATH = path.join(BASE_DIR, 'exported_wallets.jsonl');
const ARCHIVED_PATH = path.join(BASE_DIR, 'archived_wallets.jsonl');

// Performance optimizations
const DB_SETTINGS = [
    'PRAGMA journal_mode = WAL',
    'PRAGMA synchronous = NORMAL',
    'PRAGMA cache_size = 10000',
    'PRAGMA temp_store = MEMORY',
    'PRAGMA mmap_size = 134217728',
    'PRAGMA optimize'
];

class SQLiteStorage {
    constructor() {
        this.db = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        this.db = new sqlite3.Database(SQLITE_DB_PATH);

        // Apply performance settings
        DB_SETTINGS.forEach(setting => {
            this.db.run(setting);
        });

        // Ensure tables exist
        await this.ensureTables();
        await this.ensureIndexes();

        this.initialized = true;
    }

    ensureTables() {
        return new Promise((resolve, reject) => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS wallets (
                    publicKey TEXT PRIMARY KEY,
                    secretKeyBase64 TEXT,
                    startMatch TEXT,
                    endMatch TEXT,
                    startLen INTEGER,
                    endLen INTEGER,
                    matchLen INTEGER,
                    folder TEXT,
                    generatedAt TEXT,
                    isExported INTEGER DEFAULT 0,
                    isArchived INTEGER DEFAULT 0,
                    archivedAt TEXT,
                    archivedNote TEXT
                )
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    ensureIndexes() {
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_start_match ON wallets(startMatch)',
            'CREATE INDEX IF NOT EXISTS idx_end_match ON wallets(endMatch)',
            'CREATE INDEX IF NOT EXISTS idx_folder ON wallets(folder)',
            'CREATE INDEX IF NOT EXISTS idx_match_len ON wallets(matchLen)',
            'CREATE INDEX IF NOT EXISTS idx_start_len ON wallets(startLen)',
            'CREATE INDEX IF NOT EXISTS idx_end_len ON wallets(endLen)',
            'CREATE INDEX IF NOT EXISTS idx_is_exported ON wallets(isExported)',
            'CREATE INDEX IF NOT EXISTS idx_is_archived ON wallets(isArchived)',
            'CREATE INDEX IF NOT EXISTS idx_generated_at ON wallets(generatedAt)',
            'CREATE INDEX IF NOT EXISTS idx_composite_search ON wallets(startMatch, endMatch, folder)'
        ];

        return Promise.all(indexes.map(indexSql =>
            new Promise((resolve, reject) => {
                this.db.run(indexSql, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            })
        ));
    }

    async getFilteredWallets(options = {}) {
        await this.initialize();

        const {
            minLength = 3,
            typeFilter = null,
            searchInput = '',
            limit = 1000,
            offset = 0,
            minSideLength = 2,
            includePrivateKeys = false,
            exportedFilter = 'all',
            nameStyleFilter = 'all',
            archivedFilter = 'not-archived',
            countTotal = true
        } = options;

        let whereConditions = ['matchLen >= ?'];
        let params = [minLength];

        // Type filter
        if (typeFilter && typeFilter !== 'all') {
            if (typeFilter === 'start' || typeFilter === 'end' || typeFilter === 'both') {
                whereConditions.push('folder = ?');
                params.push(typeFilter);
            } else if (typeFilter === 'single') {
                whereConditions.push('(startLen > 0 AND endLen = 0) OR (endLen > 0 AND startLen = 0)');
            } else if (typeFilter === 'addition') {
                whereConditions.push('startLen >= ? AND endLen >= ?');
                params.push(minSideLength, minSideLength);
            }
        }

        // Search filter - ultra-fast direct search_terms query
        if (searchInput.trim()) {
            const searchTerms = searchInput.trim().toUpperCase();
            if (searchInput.includes(' ') || searchInput.includes(',')) {
                const terms = searchInput.split(/[,\s+]+/).filter(Boolean);
                if (terms.length >= 2) {
                    whereConditions.push(`publicKey IN (
                        SELECT publicKey FROM search_terms WHERE term = ? AND matchType = 'start'
                        INTERSECT
                        SELECT publicKey FROM search_terms WHERE term = ? AND matchType = 'end'
                    )`);
                    params.push(terms[0], terms[1]);
                }
            } else {
                // Generate leetspeak variants for comprehensive search
                const variants = generateLeetVariants(searchTerms);
                const allTerms = [searchTerms, ...variants];
                const placeholders = allTerms.map(() => '?').join(',');

                // Ultra-fast: return only search_terms data with leetspeak variants
                const fastQuery = `
                    SELECT DISTINCT publicKey, matchType, matchLen, folder
                    FROM search_terms 
                    WHERE term IN (${placeholders})
                    ORDER BY 
                        CASE WHEN folder = 'both' THEN 1 ELSE 2 END,
                        matchLen DESC
                    LIMIT ?
                `;

                const fastResults = await new Promise((resolve, reject) => {
                    this.db.all(fastQuery, [...allTerms, limit], (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    });
                });

                // Return minimal data for maximum speed
                const wallets = fastResults.map(row => ({
                    publicKey: row.publicKey,
                    privateKey: null, // Not available in search_terms
                    startMatch: row.matchType === 'start' ? searchTerms : null,
                    endMatch: row.matchType === 'end' ? searchTerms : null,
                    startLen: row.matchType === 'start' ? searchTerms.length : 0,
                    endLen: row.matchType === 'end' ? searchTerms.length : 0,
                    matchLen: row.matchLen,
                    folder: row.folder,
                    generatedAt: null, // Not available in search_terms
                    isExported: false,
                    isArchived: false,
                    archivedAt: null,
                    archivedNote: '',
                    vanityDisplay: row.matchType === 'start'
                        ? `${searchTerms}...${row.publicKey.slice(-4)}`
                        : `${row.publicKey.slice(0, 4)}...${searchTerms}`
                }));

                // Get accurate total count for search with leetspeak variants
                const countQuery = `SELECT COUNT(DISTINCT publicKey) as count FROM search_terms WHERE term IN (${placeholders})`;
                const totalCount = await new Promise((resolve, reject) => {
                    this.db.get(countQuery, allTerms, (err, row) => {
                        if (err) reject(err);
                        else resolve(row.count);
                    });
                });

                return {
                    wallets,
                    totalMatches: totalCount
                };
            }
        }

        // Exported filter
        if (exportedFilter === 'exported') {
            whereConditions.push('isExported = 1');
        } else if (exportedFilter === 'not-exported') {
            whereConditions.push('isExported = 0');
        }

        // Archived filter
        if (archivedFilter === 'archived') {
            whereConditions.push('isArchived = 1');
        } else if (archivedFilter === 'not-archived') {
            whereConditions.push('isArchived = 0');
        }

        // Name style filter
        if (nameStyleFilter === 'letters-only') {
            whereConditions.push('(startMatch NOT GLOB \'*[0-9]*\' AND endMatch NOT GLOB \'*[0-9]*\')');
        }

        // If no search, use ultra-fast indexed query for initial load
        if (!searchInput.trim()) {
            let whereClause = 'matchLen >= ?';
            let queryParams = [minLength];

            // Add type filter for initial load
            if (typeFilter && typeFilter !== 'all') {
                if (typeFilter === 'start' || typeFilter === 'end' || typeFilter === 'both') {
                    whereClause += ' AND folder = ?';
                    queryParams.push(typeFilter);
                } else if (typeFilter === 'single') {
                    whereClause += ' AND (startLen > 0 AND endLen = 0) OR (endLen > 0 AND startLen = 0)';
                } else if (typeFilter === 'addition') {
                    whereClause += ' AND startLen >= ? AND endLen >= ?';
                    queryParams.push(minSideLength, minSideLength);
                }
            }

            const fastQuery = `
                SELECT 
                    publicKey,
                    ${includePrivateKeys ? 'secretKeyBase64' : 'NULL as privateKey'},
                    startMatch,
                    endMatch,
                    startLen,
                    endLen,
                    matchLen,
                    folder,
                    generatedAt,
                    isExported,
                    isArchived,
                    archivedAt,
                    archivedNote,
                    CASE 
                        WHEN startMatch != '' AND endMatch != '' THEN startMatch || '...' || endMatch
                        WHEN startMatch != '' THEN startMatch || '...' || SUBSTR(publicKey, -4)
                        ELSE SUBSTR(publicKey, 1, 4) || '...' || endMatch
                    END as vanityDisplay
                FROM wallets 
                WHERE ${whereClause}
                ORDER BY 
                    CASE WHEN folder = 'both' THEN 1 ELSE 2 END,
                    matchLen DESC
                LIMIT ? OFFSET ?
            `;

            queryParams.push(limit, offset);

            const walletsPromise = new Promise((resolve, reject) => {
                this.db.all(fastQuery, queryParams, (err, rows) => {
                    if (err) reject(err);
                    else {
                        const wallets = rows.map(row => ({
                            publicKey: row.publicKey,
                            privateKey: row.privateKey,
                            startMatch: row.startMatch,
                            endMatch: row.endMatch,
                            startLen: row.startLen,
                            endLen: row.endLen,
                            matchLen: row.matchLen,
                            folder: row.folder,
                            generatedAt: row.generatedAt,
                            isExported: !!row.isExported,
                            isArchived: !!row.isArchived,
                            archivedAt: row.archivedAt,
                            archivedNote: row.archivedNote || '',
                            vanityDisplay: row.vanityDisplay
                        }));
                        resolve(wallets);
                    }
                });
            });

            const wallets = await walletsPromise;

            return {
                wallets,
                totalMatches: countTotal ? null : null // Skip expensive count for initial load
            };
        }

        const finalWhereClause = whereConditions.join(' AND ');

        // Build query - NO ORDER BY for maximum speed
        let query = `
            SELECT 
                publicKey,
                ${includePrivateKeys ? 'secretKeyBase64' : 'NULL as privateKey'},
                startMatch,
                endMatch,
                startLen,
                endLen,
                matchLen,
                folder,
                generatedAt,
                isExported,
                isArchived,
                archivedAt,
                archivedNote,
                CASE 
                    WHEN startMatch != '' AND endMatch != '' THEN startMatch || '...' || endMatch
                    WHEN startMatch != '' THEN startMatch || '...' || SUBSTR(publicKey, -4)
                    ELSE SUBSTR(publicKey, 1, 4) || '...' || endMatch
                END as vanityDisplay
            FROM wallets 
            WHERE ${finalWhereClause}
            LIMIT ? OFFSET ?
        `;

        params.push(limit, offset);

        // Get total count
        let totalQuery = `SELECT COUNT(*) as total FROM wallets WHERE ${finalWhereClause}`;
        let totalPromise = null;

        if (countTotal) {
            totalPromise = new Promise((resolve, reject) => {
                this.db.get(totalQuery, params.slice(0, -2), (err, row) => {
                    if (err) reject(err);
                    else resolve(row.total);
                });
            });
        }

        // Get wallets
        const walletsPromise = new Promise((resolve, reject) => {
            this.db.all(query, params, (err, rows) => {
                if (err) reject(err);
                else {
                    const wallets = rows.map(row => ({
                        publicKey: row.publicKey,
                        privateKey: row.privateKey,
                        startMatch: row.startMatch,
                        endMatch: row.endMatch,
                        startLen: row.startLen,
                        endLen: row.endLen,
                        matchLen: row.matchLen,
                        folder: row.folder,
                        generatedAt: row.generatedAt,
                        isExported: !!row.isExported,
                        isArchived: !!row.isArchived,
                        archivedAt: row.archivedAt,
                        archivedNote: row.archivedNote || '',
                        vanityDisplay: row.vanityDisplay
                    }));
                    resolve(wallets);
                }
            });
        });

        const [wallets, totalMatches] = await Promise.all([walletsPromise, totalPromise]);

        return {
            wallets,
            totalMatches: countTotal ? totalMatches : null
        };
    }

    async addWallet(wallets) {
        await this.initialize();

        if (!Array.isArray(wallets)) {
            wallets = [wallets];
        }

        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO wallets 
            (publicKey, secretKeyBase64, startMatch, endMatch, startLen, endLen, matchLen, folder, generatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const searchStmt = this.db.prepare(`
            INSERT OR REPLACE INTO search_terms (term, publicKey, matchType, matchLen, folder)
            VALUES (?, ?, ?, ?, ?)
        `);

        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                let inserted = 0;
                wallets.forEach(wallet => {
                    const startMatch = wallet.startMatch || '';
                    const endMatch = wallet.endMatch || '';
                    const startLen = startMatch.length;
                    const endLen = endMatch.length;
                    const matchLen = startLen + endLen;

                    // Add to main wallets table
                    stmt.run([
                        wallet.publicKey,
                        wallet.secretKeyBase64 || null,
                        startMatch,
                        endMatch,
                        startLen,
                        endLen,
                        matchLen,
                        wallet.folder || 'start',
                        wallet.generatedAt || new Date().toISOString()
                    ], (err) => {
                        if (!err && this.changes > 0) inserted++;
                    });

                    // Add to search_terms table for start matches
                    if (startMatch) {
                        searchStmt.run([
                            startMatch.toUpperCase(),
                            wallet.publicKey,
                            'start',
                            startLen,
                            wallet.folder || 'start'
                        ]);
                    }

                    // Add to search_terms table for end matches
                    if (endMatch) {
                        searchStmt.run([
                            endMatch.toUpperCase(),
                            wallet.publicKey,
                            'end',
                            endLen,
                            wallet.folder || 'start'
                        ]);
                    }
                });

                this.db.run('COMMIT', (err) => {
                    stmt.finalize();
                    searchStmt.finalize();
                    if (err) reject(err);
                    else resolve({ inserted, total: wallets.length });
                });
            });
        });
    }

    async markWalletsExported(publicKeys) {
        await this.initialize();

        if (!Array.isArray(publicKeys)) {
            publicKeys = [publicKeys];
        }

        const placeholders = publicKeys.map(() => '?').join(',');
        const query = `UPDATE wallets SET isExported = 1 WHERE publicKey IN (${placeholders})`;

        return new Promise((resolve, reject) => {
            this.db.run(query, publicKeys, function (err) {
                if (err) reject(err);
                else resolve({ marked: this.changes, requested: publicKeys.length });
            });
        });
    }

    async markWalletsArchived(entries) {
        await this.initialize();

        if (!Array.isArray(entries)) {
            entries = [entries];
        }

        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run('BEGIN TRANSACTION');

                let archived = 0;
                let updated = 0;

                entries.forEach(({ publicKey, note }) => {
                    const query = `
                        UPDATE wallets 
                        SET isArchived = 1, archivedAt = ?, archivedNote = ? 
                        WHERE publicKey = ?
                    `;

                    this.db.run(query, [new Date().toISOString(), note, publicKey], function (err) {
                        if (err) return;
                        if (this.changes > 0) {
                            if (this.changes === 1) archived++;
                            else updated++;
                        }
                    });
                });

                this.db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    else resolve({ archived, updated, total: entries.length });
                });
            });
        });
    }

    async getWalletPrivateKeys(publicKeys) {
        await this.initialize();

        if (!Array.isArray(publicKeys)) {
            publicKeys = [publicKeys];
        }

        const placeholders = publicKeys.map(() => '?').join(',');
        const query = `
            SELECT publicKey, secretKeyBase64 as privateKey 
            FROM wallets 
            WHERE publicKey IN (${placeholders})
        `;

        return new Promise((resolve, reject) => {
            this.db.all(query, publicKeys, (err, rows) => {
                if (err) reject(err);
                else resolve({
                    wallets: rows,
                    found: rows.length,
                    requested: publicKeys.length
                });
            });
        });
    }

    async getWalletStats() {
        await this.initialize();

        const statsQuery = `
            SELECT 
                COUNT(*) as totalWallets,
                folder,
                COUNT(*) as count,
                CASE 
                    WHEN (startLen > 0 AND endLen > 0) AND (startLen >= 8 OR endLen >= 8 OR (startLen >= 5 AND endLen >= 5)) THEN 'ultra'
                    WHEN (startLen > 0 AND endLen > 0) AND (startLen >= 7 OR endLen >= 7 OR (startLen >= 4 AND endLen >= 5)) THEN 'epic'
                    WHEN (startLen > 0 AND endLen > 0) AND (startLen >= 6 OR endLen >= 6 OR (startLen >= 3 AND endLen >= 4)) THEN 'rare'
                    WHEN matchLen >= 4 THEN 'good'
                    ELSE 'common'
                END as rarity
            FROM wallets 
            GROUP BY folder, rarity
        `;

        return new Promise((resolve, reject) => {
            this.db.all(statsQuery, (err, rows) => {
                if (err) reject(err);
                else {
                    const stats = {
                        totalWallets: 0,
                        byFolder: { start: 0, end: 0, both: 0 },
                        rarity: { ultra: 0, epic: 0, rare: 0, good: 0, common: 0 }
                    };

                    rows.forEach(row => {
                        stats.totalWallets += row.count;
                        stats.byFolder[row.folder] = (stats.byFolder[row.folder] || 0) + row.count;
                        stats.rarity[row.rarity] = (stats.rarity[row.rarity] || 0) + row.count;
                    });

                    resolve(stats);
                }
            });
        });
    }

    async rebuildIndexes() {
        await this.initialize();

        console.log('Dropping indexes for rebuild...');
        const dropIndexes = [
            'DROP INDEX IF EXISTS idx_start_match',
            'DROP INDEX IF EXISTS idx_end_match',
            'DROP INDEX IF EXISTS idx_folder',
            'DROP INDEX IF EXISTS idx_match_len',
            'DROP INDEX IF EXISTS idx_start_len',
            'DROP INDEX IF EXISTS idx_end_len',
            'DROP INDEX IF EXISTS idx_is_exported',
            'DROP INDEX IF EXISTS idx_is_archived',
            'DROP INDEX IF EXISTS idx_generated_at',
            'DROP INDEX IF EXISTS idx_composite_search'
        ];

        for (const dropSql of dropIndexes) {
            await new Promise(resolve => this.db.run(dropSql, resolve));
        }

        console.log('Recreating indexes...');
        await this.ensureIndexes();
        console.log('Indexes rebuilt successfully');
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.initialized = false;
        }
    }
}

// Singleton instance
const storage = new SQLiteStorage();

module.exports = {
    getFilteredWallets: (options) => storage.getFilteredWallets(options),
    addWallet: (wallets) => storage.addWallet(wallets),
    markWalletsExported: (publicKeys) => storage.markWalletsExported(publicKeys),
    markWalletsArchived: (entries) => storage.markWalletsArchived(entries),
    getWalletPrivateKeys: (publicKeys) => storage.getWalletPrivateKeys(publicKeys),
    getWalletStats: () => storage.getWalletStats(),
    rebuildIndexes: () => storage.rebuildIndexes(),
    initialize: () => storage.initialize(),
    close: () => storage.close()
};
