const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { generateLeetVariants } = require('./leet_cache');

const BASE_DIR = 'novelty_wallets';
const SQLITE_DB_PATH = path.join(BASE_DIR, 'wallets.db');
const EXPORTED_PATH = path.join(BASE_DIR, 'exported_wallets.jsonl');
const ARCHIVED_PATH = path.join(BASE_DIR, 'archived_wallets.jsonl');
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const SQLITE_WRITE_RETRY_ATTEMPTS = 6;
const SQLITE_WRITE_RETRY_DELAY_MS = 120;

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
        this.initializePromise = null;
        this.writeReady = false;
        this.writeReadyPromise = null;
    }

    async initialize() {
        if (this.initialized) return;
        if (this.initializePromise) {
            await this.initializePromise;
            return;
        }

        this.initializePromise = (async () => {
            this.db = new sqlite3.Database(SQLITE_DB_PATH);
            this.db.configure('busyTimeout', SQLITE_BUSY_TIMEOUT_MS);
            this.initialized = true;
        })();

        try {
            await this.initializePromise;
        } catch (err) {
            this.initializePromise = null;
            this.initialized = false;
            if (this.db) {
                try { this.db.close(); } catch { }
                this.db = null;
            }
            throw err;
        }
    }

    async ensureWriteReady() {
        await this.initialize();
        if (this.writeReady) return;
        if (this.writeReadyPromise) {
            await this.writeReadyPromise;
            return;
        }

        this.writeReadyPromise = (async () => {
            for (const setting of DB_SETTINGS) {
                await new Promise((resolve, reject) => {
                    this.db.run(setting, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }

            await this.ensureTables();
            await this.ensureIndexes();
            this.writeReady = true;
        })();

        try {
            await this.writeReadyPromise;
        } catch (err) {
            this.writeReadyPromise = null;
            this.writeReady = false;
            throw err;
        }
    }

    ensureTables() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('wallets', 'search_terms')`,
                (err, rows) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const existing = new Set((rows || []).map(row => row.name));
                    const missingStatements = [];

                    if (!existing.has('wallets')) {
                        missingStatements.push(`
                            CREATE TABLE wallets (
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
                        `);
                    }

                    if (!existing.has('search_terms')) {
                        missingStatements.push(`
                            CREATE TABLE search_terms (
                                term TEXT NOT NULL,
                                publicKey TEXT NOT NULL,
                                matchType TEXT NOT NULL,
                                matchLen INTEGER NOT NULL,
                                folder TEXT NOT NULL,
                                PRIMARY KEY (term, publicKey, matchType)
                            )
                        `);
                    }

                    if (missingStatements.length === 0) {
                        resolve();
                        return;
                    }

                    this.db.serialize(() => {
                        let remaining = missingStatements.length;
                        missingStatements.forEach((sql) => {
                            this.db.run(sql, (runErr) => {
                                if (runErr) {
                                    reject(runErr);
                                    return;
                                }
                                remaining -= 1;
                                if (remaining === 0) resolve();
                            });
                        });
                    });
                }
            );
        });
    }

    ensureIndexes() {
        const indexes = {
            idx_start_match: 'CREATE INDEX idx_start_match ON wallets(startMatch)',
            idx_end_match: 'CREATE INDEX idx_end_match ON wallets(endMatch)',
            idx_folder: 'CREATE INDEX idx_folder ON wallets(folder)',
            idx_match_len: 'CREATE INDEX idx_match_len ON wallets(matchLen)',
            idx_start_len: 'CREATE INDEX idx_start_len ON wallets(startLen)',
            idx_end_len: 'CREATE INDEX idx_end_len ON wallets(endLen)',
            idx_is_exported: 'CREATE INDEX idx_is_exported ON wallets(isExported)',
            idx_is_archived: 'CREATE INDEX idx_is_archived ON wallets(isArchived)',
            idx_generated_at: 'CREATE INDEX idx_generated_at ON wallets(generatedAt)',
            idx_composite_search: 'CREATE INDEX idx_composite_search ON wallets(startMatch, endMatch, folder)',
            idx_search_terms_term_type: 'CREATE INDEX idx_search_terms_term_type ON search_terms(term, matchType)',
            idx_search_terms_public_key: 'CREATE INDEX idx_search_terms_public_key ON search_terms(publicKey)'
        };

        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${Object.keys(indexes).map(() => '?').join(',')})`,
                Object.keys(indexes),
                (err, rows) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const existing = new Set((rows || []).map(row => row.name));
                    const missing = Object.entries(indexes).filter(([name]) => !existing.has(name));

                    if (missing.length === 0) {
                        resolve();
                        return;
                    }

                    let remaining = missing.length;
                    missing.forEach(([, sql]) => {
                        this.db.run(sql, (runErr) => {
                            if (runErr) {
                                reject(runErr);
                                return;
                            }
                            remaining -= 1;
                            if (remaining === 0) resolve();
                        });
                    });
                }
            );
        });
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    isBusyError(err) {
        return err?.code === 'SQLITE_BUSY' || err?.errno === 5;
    }

    async runWithRetry(executor, attempt = 0) {
        try {
            return await executor();
        } catch (err) {
            if (!this.isBusyError(err) || attempt >= SQLITE_WRITE_RETRY_ATTEMPTS) {
                throw err;
            }
            await this.delay(SQLITE_WRITE_RETRY_DELAY_MS * (attempt + 1));
            return this.runWithRetry(executor, attempt + 1);
        }
    }

    async runSql(sql, params = []) {
        return this.runWithRetry(() => new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) reject(err);
                else resolve({ changes: this.changes, lastID: this.lastID });
            });
        }));
    }

    async runStatement(stmt, params = []) {
        return this.runWithRetry(() => new Promise((resolve, reject) => {
            stmt.run(params, function (err) {
                if (err) reject(err);
                else resolve({ changes: this.changes, lastID: this.lastID });
            });
        }));
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
            if (searchInput.includes(' ') || searchInput.includes(',') || searchInput.includes('+')) {
                const terms = searchInput.split(/[,\s+]+/).filter(Boolean);
                if (terms.length >= 2) {
                    const [firstTerm, secondTerm] = terms;
                    const firstVariants = Array.from(generateLeetVariants(firstTerm)).map(term => term.toUpperCase());
                    const secondVariants = Array.from(generateLeetVariants(secondTerm)).map(term => term.toUpperCase());
                    const firstTerms = [firstTerm.toUpperCase(), ...firstVariants];
                    const secondTerms = [secondTerm.toUpperCase(), ...secondVariants];
                    const firstPlaceholders = firstTerms.map(() => '?').join(',');
                    const secondPlaceholders = secondTerms.map(() => '?').join(',');

                    // Fast path for pair search using search_terms index
                    const pairQuery = `
                        SELECT DISTINCT s.publicKey, s.matchLen as startLen, e.matchLen as endLen, s.folder as folder
                        FROM search_terms s
                        JOIN search_terms e ON s.publicKey = e.publicKey
                        WHERE s.term IN (${firstPlaceholders}) AND s.matchType = 'start'
                          AND e.term IN (${secondPlaceholders}) AND e.matchType = 'end'
                        LIMIT ? OFFSET ?
                    `;
                    const pairResults = await new Promise((resolve, reject) => {
                        this.db.all(pairQuery, [...firstTerms, ...secondTerms, limit, offset], (err, rows) => {
                            if (err) reject(err);
                            else resolve(rows);
                        });
                    });

                    const wallets = pairResults.map(row => ({
                        publicKey: row.publicKey,
                        privateKey: null,
                        startMatch: firstTerm.toUpperCase(),
                        endMatch: secondTerm.toUpperCase(),
                        startLen: row.startLen,
                        endLen: row.endLen,
                        matchLen: (row.startLen || 0) + (row.endLen || 0),
                        folder: row.folder || 'both',
                        generatedAt: null,
                        isExported: false,
                        isArchived: false,
                        archivedAt: null,
                        archivedNote: '',
                        vanityDisplay: `${firstTerm.toUpperCase()}...${secondTerm.toUpperCase()}`
                    }));

                    let totalCount = null;
                    if (countTotal) {
                        const countQuery = `
                            SELECT COUNT(DISTINCT s.publicKey) as count
                            FROM search_terms s
                            JOIN search_terms e ON s.publicKey = e.publicKey
                            WHERE s.term IN (${firstPlaceholders}) AND s.matchType = 'start'
                              AND e.term IN (${secondPlaceholders}) AND e.matchType = 'end'
                        `;
                        totalCount = await new Promise((resolve, reject) => {
                            this.db.get(countQuery, [...firstTerms, ...secondTerms], (err, row) => {
                                if (err) reject(err);
                                else resolve(row.count);
                            });
                        });
                    }

                    return {
                        wallets,
                        totalMatches: countTotal ? totalCount : null
                    };
                }
            } else {
                // Generate leetspeak variants for comprehensive search
                const variants = generateLeetVariants(searchTerms);
                const allTerms = [searchTerms, ...variants];
                const placeholders = allTerms.map(() => '?').join(',');

                // Join wallets so 'both' wallets always show real startMatch/endMatch
                const fastQuery = `
                    SELECT DISTINCT
                        w.publicKey,
                        ${includePrivateKeys ? 'w.secretKeyBase64' : 'NULL as privateKey'},
                        w.startMatch,
                        w.endMatch,
                        w.startLen,
                        w.endLen,
                        w.matchLen,
                        w.folder,
                        w.generatedAt,
                        w.isExported,
                        w.isArchived,
                        w.archivedAt,
                        w.archivedNote,
                        CASE
                            WHEN w.startMatch != '' AND w.endMatch != '' THEN w.startMatch || '...' || w.endMatch
                            WHEN w.startMatch != '' THEN w.startMatch || '...' || SUBSTR(w.publicKey, -4)
                            ELSE SUBSTR(w.publicKey, 1, 4) || '...' || w.endMatch
                        END as vanityDisplay
                    FROM wallets w
                    INNER JOIN search_terms st ON w.publicKey = st.publicKey
                    WHERE st.term IN (${placeholders})
                    ORDER BY
                        CASE WHEN w.folder = 'both' THEN 1 ELSE 2 END,
                        w.matchLen DESC
                    LIMIT ? OFFSET ?
                `;

                const fastResults = await new Promise((resolve, reject) => {
                    this.db.all(fastQuery, [...allTerms, limit, offset], (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    });
                });

                const wallets = fastResults.map(row => ({
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

                let totalCount = null;
                if (countTotal) {
                    const countQuery = `
                        SELECT COUNT(DISTINCT w.publicKey) as count
                        FROM wallets w
                        INNER JOIN search_terms st ON w.publicKey = st.publicKey
                        WHERE st.term IN (${placeholders})
                    `;
                    totalCount = await new Promise((resolve, reject) => {
                        this.db.get(countQuery, allTerms, (err, row) => {
                            if (err) reject(err);
                            else resolve(row.count);
                        });
                    });
                }

                return {
                    wallets,
                    totalMatches: countTotal ? totalCount : null
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

        const useFastPath = !searchInput.trim()
            && exportedFilter === 'all'
            && archivedFilter === 'not-archived'
            && nameStyleFilter === 'all';

        const mapWalletRow = (row) => ({
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
        });

        // If no search, use ultra-fast indexed query for initial load
        if (useFastPath) {
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

            const selectClause = `
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
            `;

            const runAllQuery = (sql, params) => new Promise((resolve, reject) => {
                this.db.all(sql, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows.map(mapWalletRow));
                });
            });

            const wallets = await runAllQuery(
                `${selectClause}
                 WHERE ${whereClause}
                 ORDER BY matchLen DESC
                 LIMIT ? OFFSET ?`,
                [...queryParams, limit, offset]
            );

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
        await this.ensureWriteReady();

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

        let inserted = 0;

        try {
            await this.runSql('BEGIN IMMEDIATE TRANSACTION');

            for (const wallet of wallets) {
                const startMatch = wallet.startMatch || '';
                const endMatch = wallet.endMatch || '';
                const startLen = startMatch.length;
                const endLen = endMatch.length;
                const matchLen = startLen + endLen;
                const folder = wallet.folder || 'start';

                const walletResult = await this.runStatement(stmt, [
                    wallet.publicKey,
                    wallet.secretKeyBase64 || null,
                    startMatch,
                    endMatch,
                    startLen,
                    endLen,
                    matchLen,
                    folder,
                    wallet.generatedAt || new Date().toISOString()
                ]);

                inserted += walletResult.changes > 0 ? 1 : 0;

                if (startMatch) {
                    await this.runStatement(searchStmt, [
                        startMatch.toUpperCase(),
                        wallet.publicKey,
                        'start',
                        startLen,
                        folder
                    ]);
                }

                if (endMatch) {
                    await this.runStatement(searchStmt, [
                        endMatch.toUpperCase(),
                        wallet.publicKey,
                        'end',
                        endLen,
                        folder
                    ]);
                }
            }

            await this.runSql('COMMIT');
            return { inserted, total: wallets.length };
        } catch (err) {
            try {
                await this.runSql('ROLLBACK');
            } catch { }
            throw err;
        } finally {
            stmt.finalize();
            searchStmt.finalize();
        }
    }

    async markWalletsExported(publicKeys) {
        await this.ensureWriteReady();

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
        await this.ensureWriteReady();

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
        await this.ensureWriteReady();

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
            this.initializePromise = null;
            this.writeReady = false;
            this.writeReadyPromise = null;
        }
    }
}

const storageGlobal = globalThis;
if (!storageGlobal.__walletoolSQLiteStorage) {
    storageGlobal.__walletoolSQLiteStorage = new SQLiteStorage();
}
const storage = storageGlobal.__walletoolSQLiteStorage;

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
