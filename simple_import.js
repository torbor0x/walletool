const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const BASE_DIR = 'novelty_wallets';
const FOLDERS = ['start', 'end', 'both'];
const DB_PATH = path.join(BASE_DIR, 'wallets.db');

function importFolder(folder, callback) {
    const filePath = path.join(BASE_DIR, folder, `${folder}_wallets.jsonl`);

    if (!fs.existsSync(filePath)) {
        console.log(`Skipping ${folder} - file not found`);
        return callback();
    }

    console.log(`\n📁 Importing ${folder}...`);

    const db = new sqlite3.Database(DB_PATH);
    const stmt = db.prepare(`
        INSERT OR IGNORE INTO wallets 
        (publicKey, secretKeyBase64, startMatch, endMatch, startLen, endLen, matchLen, folder, generatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let processed = 0;
    let imported = 0;
    let batch = [];
    const BATCH_SIZE = 1000;

    // Stream the file
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buffer = '';

    stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const data = JSON.parse(line);
                const startMatch = data.startMatch || '';
                const endMatch = data.endMatch || '';

                batch.push([
                    data.publicKey,
                    data.secretKeyBase64 || null,
                    startMatch || null,
                    endMatch || null,
                    startMatch.length,
                    endMatch.length,
                    startMatch.length + endMatch.length,
                    folder,
                    data.generatedAt || null
                ]);

                processed++;

                // Insert batch when full
                if (batch.length >= BATCH_SIZE) {
                    for (const params of batch) {
                        stmt.run(params, function (err) {
                            if (!err) imported++;
                        });
                    }
                    batch = [];
                }

                // Show progress every 50000 lines
                if (processed % 50000 === 0) {
                    console.log(`  📊 ${processed.toLocaleString()} processed (${imported.toLocaleString()} imported)`);
                }
            } catch (e) {
                // Skip invalid lines
            }
        }
    });

    stream.on('end', () => {
        // Process remaining buffer
        if (buffer.trim()) {
            try {
                const data = JSON.parse(buffer);
                const startMatch = data.startMatch || '';
                const endMatch = data.endMatch || '';

                batch.push([
                    data.publicKey,
                    data.secretKeyBase64 || null,
                    startMatch || null,
                    endMatch || null,
                    startMatch.length,
                    endMatch.length,
                    startMatch.length + endMatch.length,
                    folder,
                    data.generatedAt || null
                ]);

                processed++;
            } catch (e) {
                // Skip invalid line
            }
        }

        // Insert remaining batch
        for (const params of batch) {
            stmt.run(params, function (err) {
                if (!err) imported++;
            });
        }

        stmt.finalize(() => {
            db.close(() => {
                console.log(`✅ ${folder} complete: ${processed.toLocaleString()} processed, ${imported.toLocaleString()} imported`);
                callback();
            });
        });
    });

    stream.on('error', (err) => {
        console.error(`Error reading ${filePath}:`, err);
        callback();
    });
}

// Initialize database
console.log('🚀 Starting simple wallet import...');

const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS wallets (
            publicKey TEXT PRIMARY KEY,
            secretKeyBase64 TEXT,
            startMatch TEXT,
            endMatch TEXT,
            startLen INTEGER,
            endLen INTEGER,
            matchLen INTEGER,
            folder TEXT,
            generatedAt TEXT
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_start_match ON wallets(startMatch)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_end_match ON wallets(endMatch)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_folder ON wallets(folder)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_match_len ON wallets(matchLen)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_start_len ON wallets(startLen)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_end_len ON wallets(endLen)`);

    db.close(() => {
        // Import folders sequentially
        let current = 0;

        function next() {
            if (current < FOLDERS.length) {
                importFolder(FOLDERS[current], next);
                current++;
            } else {
                console.log('\n🎉 Import completed!');

                // Show final count
                const finalDb = new sqlite3.Database(DB_PATH);
                finalDb.all("SELECT folder, COUNT(*) as count FROM wallets GROUP BY folder", (err, rows) => {
                    if (!err) {
                        console.log('\n📊 Final counts:');
                        rows.forEach(row => {
                            console.log(`  ${row.folder}: ${row.count.toLocaleString()}`);
                        });
                    }

                    finalDb.get("SELECT COUNT(*) as total FROM wallets", (err, row) => {
                        if (!err) {
                            console.log(`\n📊 Total: ${row.total.toLocaleString()} wallets`);
                        }
                        finalDb.close();
                    });
                });
            }
        }

        next();
    });
});
