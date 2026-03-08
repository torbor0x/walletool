const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

console.log('🚀 ULTIMATE IMPORT - ALL FILES, MAXIMUM OPTIMIZATION');
console.log('Processing start, end, and both files with peak performance\n');

const db = new sqlite3.Database('novelty_wallets/wallets.db');
const CHECKPOINT_FILE = 'novelty_wallets/ultimate_import_checkpoint.json';

// All files to process
const FILES = [
    { name: 'start', path: 'novelty_wallets/start/start_wallets.jsonl', lines: 34122922 },
    { name: 'end', path: 'novelty_wallets/end/end_wallets.jsonl', lines: 27476388 },
    { name: 'both', path: 'novelty_wallets/both/both_wallets.jsonl', lines: 3301222 }
];

// MAXIMUM PERFORMANCE SETTINGS
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = 30000'); // 30MB cache
db.run('PRAGMA temp_store = MEMORY');
db.run('PRAGMA mmap_size = 268435456'); // 256MB memory map
db.run('PRAGMA locking_mode = EXCLUSIVE');
db.run('PRAGMA optimize');

// Periodic optimization
let batchCount = 0;
const OPTIMIZE_INTERVAL = 50; // Every 50 batches

function optimizeDatabase() {
    console.log('🔧 Optimizing database performance...');
    db.run('PRAGMA optimize');
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    if (global.gc) global.gc();
}

function saveCheckpoint(data) {
    try {
        fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({
            ...data,
            timestamp: new Date().toISOString()
        }, null, 2));
        console.log(`💾 Checkpoint saved: ${data.currentFile} line ${data.lineNumber}, ${data.totalImported} total imported`);
    } catch (e) {
        console.error('Failed to save checkpoint:', e.message);
    }
}

function loadCheckpoint() {
    try {
        if (fs.existsSync(CHECKPOINT_FILE)) {
            return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Failed to load checkpoint:', e.message);
    }
    return null;
}

let checkpoint = loadCheckpoint();
let currentFileIndex = checkpoint ? checkpoint.currentFileIndex : 0;
let startLine = checkpoint ? checkpoint.lineNumber : 0;
let totalImported = checkpoint ? checkpoint.totalImported : 0;
let totalProcessed = checkpoint ? checkpoint.totalProcessed : 0;

console.log(`Resuming: file ${currentFileIndex} (${FILES[currentFileIndex].name}), line ${startLine}`);
console.log(`Already imported: ${totalImported.toLocaleString()} wallets`);

function processFile(fileIndex, startLine, callback) {
    const file = FILES[fileIndex];
    console.log(`\n📁 Processing file ${fileIndex + 1}/3: ${file.name} (${file.lines.toLocaleString()} lines)`);
    
    const fd = fs.openSync(file.path, 'r');
    const buffer = Buffer.allocUnsafe(256 * 1024); // 256KB buffer
    let leftover = '';
    let currentLine = 0;
    let fileImported = 0;
    
    // Skip to start line
    if (startLine > 0) {
        console.log(`Fast skipping to line ${startLine}...`);
        while (currentLine < startLine) {
            const bytesRead = fs.readSync(fd, buffer, 0, 256 * 1024, null);
            if (bytesRead <= 0) break;
            const chunk = buffer.toString('utf8', 0, bytesRead);
            const lines = chunk.split('\n');
            currentLine += lines.length;
        }
        console.log(`Skipped to line ${currentLine}`);
    }
    
    const BATCH_SIZE = 80000; // Optimal batch size
    let batchCount = 0;
    
    function processBatch() {
        batchCount++;
        global.batchCount++;
        
        const batchData = [];
        let batchCollected = 0;
        
        console.log(`\n📦 Batch ${batchCount} (${file.name}): Collecting ${BATCH_SIZE} wallets...`);
        
        // Collect batch data
        while (batchCollected < BATCH_SIZE) {
            const bytesRead = fs.readSync(fd, buffer, 0, 256 * 1024, null);
            if (bytesRead <= 0) {
                console.log(`End of ${file.name} file reached!`);
                fs.closeSync(fd);
                callback(fileImported, currentLine, true); // File completed
                return;
            }
            
            const chunk = leftover + buffer.toString('utf8', 0, bytesRead);
            const lines = chunk.split('\n');
            leftover = lines.pop() || '';
            
            for (const rawLine of lines) {
                if (batchCollected >= BATCH_SIZE) break;
                
                try {
                    const data = JSON.parse(rawLine.trim());
                    if (!data.publicKey) {
                        currentLine++;
                        continue;
                    }
                    
                    batchData.push([
                        data.publicKey,
                        data.secretKeyBase64 || null,
                        data.startMatch || null,
                        data.endMatch || null,
                        (data.startMatch || '').length,
                        (data.endMatch || '').length,
                        ((data.startMatch || '').length + (data.endMatch || '').length),
                        file.name,
                        data.generatedAt || null
                    ]);
                    
                    batchCollected++;
                    currentLine++;
                    
                } catch (e) {
                    currentLine++;
                }
            }
        }
        
        console.log(`Collected ${batchData.length} wallets, inserting...`);
        
        // Insert batch
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO wallets 
            (publicKey, secretKeyBase64, startMatch, endMatch, startLen, endLen, matchLen, folder, generatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const startTime = Date.now();
        
        db.serialize(() => {
            db.run('BEGIN IMMEDIATE TRANSACTION');
            
            for (const row of batchData) {
                stmt.run(row);
            }
            
            db.run('COMMIT', (err) => {
                stmt.finalize();
                const duration = Date.now() - startTime;
                
                if (err) {
                    console.error('❌ Batch failed:', err.message);
                    fs.closeSync(fd);
                    callback(fileImported, currentLine, false);
                    return;
                }
                
                fileImported += batchData.length;
                totalImported += batchData.length;
                totalProcessed += batchData.length;
                
                console.log(`✅ Batch ${batchCount} completed in ${(duration/1000).toFixed(1)}s`);
                console.log(`   Inserted: ${batchData.length.toLocaleString()}`);
                console.log(`   File total: ${fileImported.toLocaleString()}, Overall: ${totalImported.toLocaleString()}`);
                console.log(`   Speed: ${(batchData.length/(duration/1000)).toFixed(0)} wallets/sec`);
                console.log(`   Progress: ${((currentLine / file.lines) * 100).toFixed(2)}% of ${file.name}`);
                
                // Periodic optimization
                if (global.batchCount % OPTIMIZE_INTERVAL === 0) {
                    optimizeDatabase();
                }
                
                // Save checkpoint
                if (batchCount % 10 === 0) {
                    saveCheckpoint({
                        currentFileIndex: fileIndex,
                        currentFile: file.name,
                        lineNumber: currentLine,
                        totalImported: totalImported,
                        totalProcessed: totalProcessed,
                        batchCount: global.batchCount
                    });
                }
                
                // Continue with next batch
                setImmediate(processBatch);
            });
        });
    }
    
    // Start processing
    processBatch();
}

function startProcessing() {
    if (currentFileIndex >= FILES.length) {
        console.log('\n🎉 ALL FILES COMPLETED!');
        finish();
        return;
    }
    
    processFile(currentFileIndex, startLine, (fileImported, endLine, fileCompleted) => {
        console.log(`\n📊 File ${FILES[currentFileIndex].name} completed:`);
        console.log(`   Imported: ${fileImported.toLocaleString()} wallets`);
        console.log(`   Ended at line: ${endLine.toLocaleString()}`);
        
        if (fileCompleted) {
            // Move to next file
            currentFileIndex++;
            startLine = 0;
            
            if (currentFileIndex < FILES.length) {
                console.log(`\n🔄 Moving to next file: ${FILES[currentFileIndex].name}`);
                setTimeout(() => startProcessing(), 1000);
            } else {
                finish();
            }
        } else {
            // Error - save and exit
            saveCheckpoint({
                currentFileIndex: currentFileIndex,
                currentFile: FILES[currentFileIndex].name,
                lineNumber: endLine,
                totalImported: totalImported,
                totalProcessed: totalProcessed,
                batchCount: global.batchCount,
                error: true
            });
            finish();
        }
    });
}

function finish() {
    console.log('\n🔄 Recreating indexes for final database...');
    
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_public_key ON wallets(publicKey);',
        'CREATE INDEX IF NOT EXISTS idx_start_match ON wallets(startMatch);',
        'CREATE INDEX IF NOT EXISTS idx_end_match ON wallets(endMatch);',
        'CREATE INDEX IF NOT EXISTS idx_folder ON wallets(folder);',
        'CREATE INDEX IF NOT EXISTS idx_match_len ON wallets(matchLen);'
    ];
    
    let completed = 0;
    indexes.forEach((indexSql, i) => {
        db.run(indexSql, (err) => {
            if (err) console.error(`Index ${i} error:`, err.message);
            else {
                completed++;
                console.log(`✅ Index ${completed}/5 recreated`);
                if (completed === indexes.length) {
                    finalCount();
                }
            }
        });
    });
}

function finalCount() {
    db.get('SELECT COUNT(*) as count FROM wallets', (err, row) => {
        if (!err && row) {
            console.log(`\n🎉 ULTIMATE IMPORT COMPLETED!`);
            console.log(`Final database count: ${row.count.toLocaleString()}`);
            console.log(`Total added this session: ${row.count - (checkpoint ? checkpoint.dbCountAtStart : 6496435)}`);
            
            // Calculate estimates
            const remainingWallets = 64900532 - totalProcessed;
            const avgSpeed = 4000; // wallets/sec based on current performance
            const remainingHours = remainingWallets / (avgSpeed * 3600);
            
            console.log(`\n📊 PERFORMANCE SUMMARY:`);
            console.log(`   Processed: ${totalProcessed.toLocaleString()} / 64,900,532 wallets`);
            console.log(`   Remaining: ${remainingWallets.toLocaleString()} wallets`);
            console.log(`   Estimated time remaining: ${remainingHours.toFixed(1)} hours`);
            console.log(`   Average speed: ~${avgSpeed.toLocaleString()} wallets/sec`);
            
            saveCheckpoint({
                currentFileIndex: FILES.length, // Mark as completed
                lineNumber: 0,
                totalImported: totalImported,
                totalProcessed: totalProcessed,
                batchCount: global.batchCount,
                completed: true,
                finalCount: row.count
            });
        }
        db.close();
    });
}

// Start processing
console.log(`Starting DB count check...`);
db.get('SELECT COUNT(*) as count FROM wallets', (err, row) => {
    if (!err && row) {
        console.log(`Current DB count: ${row.count.toLocaleString()}`);
        if (!checkpoint) {
            checkpoint = { dbCountAtStart: row.count };
        }
        
        // Calculate estimates
        const totalWallets = 64900532;
        const remainingWallets = totalWallets - row.count;
        const avgSpeed = 4000;
        const totalHours = remainingWallets / (avgSpeed * 3600);
        
        console.log(`\n📊 ESTIMATES:`);
        console.log(`   Total wallets to process: ${totalWallets.toLocaleString()}`);
        console.log(`   Already in database: ${row.count.toLocaleString()}`);
        console.log(`   Remaining to import: ${remainingWallets.toLocaleString()}`);
        console.log(`   Estimated total time: ${totalHours.toFixed(1)} hours`);
        
        startProcessing();
    } else {
        console.error('Failed to get DB count:', err);
        db.close();
    }
});
