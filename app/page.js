// app/page.js
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export default function Home() {
    const WALLET_PAGE_SIZE = 500;
    const SEARCH_DEBOUNCE_MS = 1000;
    const [wallets, setWallets] = useState([]);
    const [sessionFinds, setSessionFinds] = useState([]);
    const [isRunning, setIsRunning] = useState(false);
    const [isStopping, setIsStopping] = useState(false);
    const [minutes, setMinutes] = useState(30);
    const [repeatCycle, setRepeatCycle] = useState('');
    const [minLength, setMinLength] = useState(6);
    const [typeFilter, setTypeFilter] = useState('all');
    const [exportedFilter, setExportedFilter] = useState('all');
    const [archivedFilter, setArchivedFilter] = useState('not-archived');
    const [nameStyleFilter, setNameStyleFilter] = useState('all');
    const [minSideLength, setMinSideLength] = useState(2);
    const [walletsLoading, setWalletsLoading] = useState(false);
    const [walletsLoadingMore, setWalletsLoadingMore] = useState(false);
    const [totalMatches, setTotalMatches] = useState(null);
    const [hasMoreWallets, setHasMoreWallets] = useState(false);
    const [tableScope, setTableScope] = useState('all');
    const [searchTerm, setSearchTerm] = useState('');
    const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
    const [searchDebouncing, setSearchDebouncing] = useState(false);
    const [sortColumn, setSortColumn] = useState('matchLen');
    const [sortDir, setSortDir] = useState('desc');
    const [selectedWalletKeys, setSelectedWalletKeys] = useState(new Set());
    const [showExportModal, setShowExportModal] = useState(false);
    const [exportWithMark, setExportWithMark] = useState(true);
    const [exportWithArchive, setExportWithArchive] = useState(false);
    const [exportArchiveNote, setExportArchiveNote] = useState('');
    const [isExporting, setIsExporting] = useState(false);
    const [exportUiStatus, setExportUiStatus] = useState('');
    const [showArchiveModal, setShowArchiveModal] = useState(false);
    const [isArchiving, setIsArchiving] = useState(false);
    const [archiveUiStatus, setArchiveUiStatus] = useState('');
    const [archiveUseSameNote, setArchiveUseSameNote] = useState(true);
    const [archiveCommonNote, setArchiveCommonNote] = useState('');
    const [archiveNotesByKey, setArchiveNotesByKey] = useState({});
    const [archiveApplyByKey, setArchiveApplyByKey] = useState({});
    const [terminalLines, setTerminalLines] = useState([]);
    const [showInfoPanel, setShowInfoPanel] = useState(false);
    const [stats, setStats] = useState(null);
    const [statsLoading, setStatsLoading] = useState(false);
    const [statsError, setStatsError] = useState('');
    const [showSessionSummary, setShowSessionSummary] = useState(false);
    const [showSettledSessionFinds, setShowSettledSessionFinds] = useState(false);
    const terminalRef = useRef(null);
    const eventSourceRef = useRef(null);
    const pollIntervalRef = useRef(null);
    const walletsFetchAbortRef = useRef(null);
    const walletCountFetchAbortRef = useRef(null);
    const latestWalletQueryKeyRef = useRef('');
    const lastCountQueryKeyRef = useRef('');
    const loadMoreSentinelRef = useRef(null);
    const collapseTimersRef = useRef(new Map());

    const makeWalletQueryKey = useCallback((searchValue = debouncedSearchTerm) => (
        JSON.stringify({
            minLength,
            typeFilter,
            exportedFilter,
            archivedFilter,
            nameStyleFilter,
            minSideLength: typeFilter === 'addition' ? minSideLength : null,
            search: (searchValue || '').trim().toLowerCase()
        })
    ), [minLength, typeFilter, exportedFilter, archivedFilter, nameStyleFilter, minSideLength, debouncedSearchTerm]);

    const fetchWallets = useCallback(async ({ searchValue = debouncedSearchTerm, offset = 0, append = false } = {}) => {
        const queryKey = makeWalletQueryKey(searchValue);
        if (!append && Math.max(0, offset) === 0) {
            latestWalletQueryKeyRef.current = queryKey;
        }
        if (walletsFetchAbortRef.current) {
            try { walletsFetchAbortRef.current.abort(); } catch { }
        }
        const fetchController = new AbortController();
        walletsFetchAbortRef.current = fetchController;
        const buildWalletUrl = () => {
            let url = `/api/wallets?minLength=${minLength}&limit=${WALLET_PAGE_SIZE}&offset=${Math.max(0, offset)}&includeTotal=0`;
            if (typeFilter !== 'all') url += `&type=${typeFilter}`;
            if (typeFilter === 'addition') url += `&minSideLength=${minSideLength}`;
            if (exportedFilter !== 'all') url += `&exported=${exportedFilter}`;
            if (archivedFilter !== 'not-archived') url += `&archived=${archivedFilter}`;
            if (nameStyleFilter !== 'all') url += `&nameStyle=${nameStyleFilter}`;
            return url;
        };
        let url = buildWalletUrl();
        const activeSearch = (searchValue || '').trim();
        if (activeSearch) url += `&search=${encodeURIComponent(activeSearch)}`;
        let applied = false;
        try {
            if (!append && Math.max(0, offset) === 0) {
                setHasMoreWallets(false);
            }
            if (append) setWalletsLoadingMore(true);
            else setWalletsLoading(true);
            const res = await fetch(url, { cache: 'no-store', signal: fetchController.signal });
            if (!res.ok) throw new Error(`Wallet fetch failed (${res.status})`);
            const data = await res.json();
            const nextWallets = Array.isArray(data)
                ? data
                : (Array.isArray(data?.wallets) ? data.wallets : []);
            const nextTotalMatches = Number.isFinite(data?.totalMatches)
                ? data.totalMatches
                : null;
            if (latestWalletQueryKeyRef.current !== queryKey) return false;
            const fetchedOffset = Math.max(0, offset);
            const loadedCount = fetchedOffset + nextWallets.length;
            const moreByCount = Number.isFinite(nextTotalMatches)
                ? loadedCount < nextTotalMatches
                : nextWallets.length === WALLET_PAGE_SIZE;
            if (Array.isArray(data)) {
                // Backward compatibility for older API responses.
                if (append) {
                    setWallets(prev => {
                        const seen = new Set(prev.map(w => w.publicKey));
                        const appended = nextWallets.filter(w => !seen.has(w.publicKey));
                        return [...prev, ...appended];
                    });
                } else {
                    setWallets(nextWallets);
                }
                setTotalMatches(nextTotalMatches);
                setHasMoreWallets(moreByCount);
                applied = true;
            } else {
                if (append) {
                    setWallets(prev => {
                        const seen = new Set(prev.map(w => w.publicKey));
                        const appended = nextWallets.filter(w => !seen.has(w.publicKey));
                        return [...prev, ...appended];
                    });
                } else {
                    setWallets(nextWallets);
                }
                if (Number.isFinite(nextTotalMatches)) {
                    setTotalMatches(nextTotalMatches);
                }
                setHasMoreWallets(moreByCount);
                applied = true;
            }
        } catch (error) {
            if (error?.name === 'AbortError') return;
            setTerminalLines(prev => [...prev.slice(-200), `[ERROR] ${error.message}`]);
        } finally {
            if (append) setWalletsLoadingMore(false);
            else setWalletsLoading(false);
        }
        return applied;
    }, [minLength, typeFilter, minSideLength, exportedFilter, archivedFilter, nameStyleFilter, debouncedSearchTerm, makeWalletQueryKey]);

    const fetchWalletCount = useCallback(async (searchValue = debouncedSearchTerm) => {
        const queryKey = makeWalletQueryKey(searchValue);
        if (walletCountFetchAbortRef.current) {
            try { walletCountFetchAbortRef.current.abort(); } catch { }
        }
        const fetchController = new AbortController();
        walletCountFetchAbortRef.current = fetchController;
        let url = `/api/wallets?minLength=${minLength}&limit=1&offset=0&includeTotal=1`;
        if (typeFilter !== 'all') url += `&type=${typeFilter}`;
        if (typeFilter === 'addition') url += `&minSideLength=${minSideLength}`;
        if (exportedFilter !== 'all') url += `&exported=${exportedFilter}`;
        if (archivedFilter !== 'not-archived') url += `&archived=${archivedFilter}`;
        if (nameStyleFilter !== 'all') url += `&nameStyle=${nameStyleFilter}`;
        const activeSearch = (searchValue || '').trim();
        if (activeSearch) url += `&search=${encodeURIComponent(activeSearch)}`;
        try {
            const res = await fetch(url, { cache: 'no-store', signal: fetchController.signal });
            if (!res.ok) throw new Error(`Wallet count fetch failed (${res.status})`);
            const data = await res.json();
            if (Number.isFinite(data?.totalMatches)) {
                if (latestWalletQueryKeyRef.current !== queryKey) return;
                setTotalMatches(data.totalMatches);
            }
        } catch (error) {
            if (error?.name === 'AbortError') return;
            setTerminalLines(prev => [...prev.slice(-200), `[ERROR] ${error.message}`]);
        }
    }, [minLength, typeFilter, minSideLength, exportedFilter, archivedFilter, nameStyleFilter, debouncedSearchTerm, makeWalletQueryKey]);

    const refreshWallets = useCallback(async (searchValue = debouncedSearchTerm) => {
        const queryKey = makeWalletQueryKey(searchValue);
        const applied = await fetchWallets({ searchValue, offset: 0, append: false });
        if (!applied) return;
        if (lastCountQueryKeyRef.current !== queryKey) {
            lastCountQueryKeyRef.current = queryKey;
            fetchWalletCount(searchValue);
        }
    }, [debouncedSearchTerm, fetchWallets, fetchWalletCount, makeWalletQueryKey]);

    const fetchStats = async () => {
        try {
            setStatsLoading(true);
            setStatsError('');
            const res = await fetch('/api/stats', { cache: 'no-store' });
            if (!res.ok) throw new Error(`Stats fetch failed (${res.status})`);
            const data = await res.json();
            setStats(data);
        } catch (error) {
            setStatsError(error.message);
        } finally {
            setStatsLoading(false);
        }
    };

    const addToSession = (newWallet) => {
        const publicKey = newWallet.publicKey || '';
        const vanityDisplay = newWallet.vanityDisplay || '';
        let startMatch = typeof newWallet.startMatch === 'string' ? newWallet.startMatch : '';
        let endMatch = typeof newWallet.endMatch === 'string' ? newWallet.endMatch : '';

        if ((!startMatch || !endMatch) && vanityDisplay.includes('...')) {
            const [left, right] = vanityDisplay.split('...');
            const leftPart = left || '';
            const rightPart = right || '';
            if (!startMatch && leftPart && leftPart !== publicKey.slice(0, 4)) {
                startMatch = leftPart;
            }
            if (!endMatch && rightPart && rightPart !== publicKey.slice(-4)) {
                endMatch = rightPart;
            }
        }

        const providedStartLen = Number.isFinite(newWallet.startLen) ? newWallet.startLen : null;
        const providedEndLen = Number.isFinite(newWallet.endLen) ? newWallet.endLen : null;
        const providedMatchLen = Number.isFinite(newWallet.matchLen) ? newWallet.matchLen : null;
        const startLen = providedStartLen !== null ? providedStartLen : startMatch.length;
        const endLen = providedEndLen !== null ? providedEndLen : endMatch.length;
        const folder = newWallet.folder || (startLen > 0 && endLen > 0 ? 'both' : startLen > 0 ? 'start' : endLen > 0 ? 'end' : 'unknown');
        const createdAt = Date.now();
        const item = {
            ...newWallet,
            publicKey,
            vanityDisplay,
            startMatch,
            endMatch,
            startLen,
            endLen,
            matchLen: providedMatchLen !== null ? providedMatchLen : (startLen + endLen),
            folder,
            expired: false,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt,
            timestamp: new Date().toLocaleTimeString()
        };
        setSessionFinds(prev => [item, ...prev]);
        const timer = setTimeout(() => {
            setSessionFinds(prev => prev.map(w => (w.id === item.id ? { ...w, expired: true } : w)));
            collapseTimersRef.current.delete(item.id);
        }, 30000);
        collapseTimersRef.current.set(item.id, timer);
    };

    const startFarming = async () => {
        try {
            const body = { minutes, repeatCycle: repeatCycle ? parseInt(repeatCycle) : null };
            const res = await fetch('/api/generation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error(`Start failed (${res.status})`);
            setIsRunning(true);
            setShowSessionSummary(false);
            setShowSettledSessionFinds(false);
            setTerminalLines(prev => [...prev, '[SYSTEM] Farming started...']);
            if (showInfoPanel) fetchStats();
        } catch (error) {
            setTerminalLines(prev => [...prev.slice(-200), `[ERROR] ${error.message}`]);
        }
    };

    const stopFarming = async () => {
        try {
            setIsStopping(true);
            setIsRunning(false);
            clearInterval(pollIntervalRef.current);
            if (walletsFetchAbortRef.current) {
                try { walletsFetchAbortRef.current.abort(); } catch { }
            }
            setTerminalLines(prev => [...prev.slice(-200), '[SYSTEM] Sending stop request...']);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000);
            const res = await fetch('/api/generation', { method: 'DELETE', signal: controller.signal });
            clearTimeout(timeout);
            let payload = null;
            try {
                payload = await res.json();
            } catch { }
            if (!res.ok || payload?.success === false) {
                throw new Error(payload?.error || `Stop failed (${res.status})`);
            }
            setIsRunning(false);
            setIsStopping(false);
            setShowSessionSummary(true);
            setTerminalLines(prev => [...prev, '[SYSTEM] Stop requested. Waiting for worker shutdown...']);
            if (showInfoPanel) fetchStats();
        } catch (error) {
            setIsStopping(false);
            const msg = error?.name === 'AbortError' ? 'Stop request timed out (server did not respond in time).' : error.message;
            setTerminalLines(prev => [...prev.slice(-200), `[ERROR] ${msg}`]);
        }
    };

    const copyPubkey = (pub) => {
        navigator.clipboard.writeText(pub);
        alert('Public key copied to clipboard');
    };

    const toggleWalletSelection = (pubkey) => {
        setSelectedWalletKeys(prev => {
            const next = new Set(prev);
            if (next.has(pubkey)) next.delete(pubkey);
            else next.add(pubkey);
            return next;
        });
    };

    const handleRowClick = (event, pubkey) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest('input, button, a, [data-row-select-ignore="true"]')) return;
        if (window.getSelection && window.getSelection()?.toString()) return;
        toggleWalletSelection(pubkey);
    };

    const handleSort = (col) => {
        if (sortColumn === col) {
            setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
        } else {
            setSortColumn(col);
            setSortDir('desc');
        }
    };

    const sortedWallets = [...wallets].sort((a, b) => {
        let va = a[sortColumn];
        let vb = b[sortColumn];
        if (typeof va === 'string') {
            va = va.toLowerCase();
            vb = vb.toLowerCase();
        }
        if (va < vb) return sortDir === 'desc' ? 1 : -1;
        if (va > vb) return sortDir === 'desc' ? -1 : 1;
        return 0;
    });

    const sessionNewKeySet = new Set(sessionFinds.map(item => item.publicKey));

    const filteredWallets = sortedWallets.filter(w => {
        if (tableScope === 'session-new' && !sessionNewKeySet.has(w.publicKey)) return false;
        // type/exported/archived/name/search filtering is handled server-side by /api/wallets.
        // Keep local filtering scoped to table view mode to avoid client/server filter mismatch.
        return true;
    });
    const selectedVisibleWallets = filteredWallets.filter(w => selectedWalletKeys.has(w.publicKey));
    const walletByPublicKey = new Map(wallets.map(w => [w.publicKey, w]));
    const selectedWallets = Array.from(selectedWalletKeys)
        .map((pubkey) => walletByPublicKey.get(pubkey))
        .filter(Boolean);
    const selectedExportedWallets = selectedWallets.filter(wallet => wallet.isExported);
    const selectedCount = selectedWalletKeys.size;
    const allVisibleSelected = filteredWallets.length > 0 && filteredWallets.every(w => selectedWalletKeys.has(w.publicKey));

    const toggleSelectVisible = () => {
        setSelectedWalletKeys(prev => {
            const next = new Set(prev);
            if (allVisibleSelected) {
                filteredWallets.forEach(w => next.delete(w.publicKey));
            } else {
                filteredWallets.forEach(w => next.add(w.publicKey));
            }
            return next;
        });
    };

    const clearSelection = () => {
        setSelectedWalletKeys(new Set());
    };

    const showExportedPreset = () => {
        setMinLength(3);
        setTypeFilter('all');
        setExportedFilter('exported');
        setArchivedFilter('all');
        setNameStyleFilter('all');
        setTableScope('all');
        setSearchTerm('');
        setDebouncedSearchTerm('');
        setSearchDebouncing(false);
    };

    const decodeBase64ToBytes = (base64) => {
        const normalized = (base64 || '').trim();
        if (!normalized) return null;
        try {
            const binary = atob(normalized);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        } catch {
            return null;
        }
    };

    const bytesToHex = (bytes) => {
        if (!bytes || bytes.length === 0) return null;
        return Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    };

    const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const bytesToBase58 = (bytes) => {
        if (!bytes || bytes.length === 0) return null;
        const digits = [0];
        for (let i = 0; i < bytes.length; i += 1) {
            let carry = bytes[i];
            for (let j = 0; j < digits.length; j += 1) {
                const x = (digits[j] * 256) + carry;
                digits[j] = x % 58;
                carry = Math.floor(x / 58);
            }
            while (carry > 0) {
                digits.push(carry % 58);
                carry = Math.floor(carry / 58);
            }
        }
        let zeroPrefix = '';
        for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) {
            zeroPrefix += BASE58_ALPHABET[0];
        }
        return zeroPrefix + digits
            .reverse()
            .map((d) => BASE58_ALPHABET[d])
            .join('');
    };

    const privateKeyFormats = (privateKeyBase64) => {
        const bytes = decodeBase64ToBytes(privateKeyBase64);
        if (!bytes) {
            return {
                base64: privateKeyBase64 || null,
                hex: null,
                base58: null
            };
        }
        return {
            base64: privateKeyBase64 || null,
            hex: bytesToHex(bytes),
            base58: bytesToBase58(bytes)
        };
    };

    const exportSelectedWallets = async (markAsExported, archiveAfterExport, archiveNote) => {
        const walletsSnapshot = [...selectedWallets];
        try {
            if (walletsSnapshot.length === 0) {
                setTerminalLines(prev => [...prev.slice(-200), '[WARN] No selected wallets to export.']);
                alert('No selected wallets to export.');
                setExportUiStatus('No selected wallets.');
                return;
            }
            setIsExporting(true);
            setExportUiStatus(`Preparing export for ${walletsSnapshot.length} wallet${walletsSnapshot.length === 1 ? '' : 's'}...`);
            const selectedPubkeys = walletsSnapshot.map(wallet => wallet.publicKey);
            const keyLookupRes = await fetch('/api/wallets/private-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ publicKeys: selectedPubkeys })
            });
            if (!keyLookupRes.ok) {
                throw new Error(`Failed to fetch private keys for export (${keyLookupRes.status})`);
            }
            const keyLookupPayload = await keyLookupRes.json().catch(() => ({}));
            const privateKeyByPubkey = new Map(
                (Array.isArray(keyLookupPayload?.wallets) ? keyLookupPayload.wallets : [])
                    .filter((item) => typeof item?.publicKey === 'string')
                    .map((item) => [item.publicKey, item.privateKey || null])
            );
            const walletsForExport = walletsSnapshot.map((wallet) => {
                const resolvedPrivateKey = privateKeyByPubkey.get(wallet.publicKey) || wallet.privateKey || null;
                const formats = privateKeyFormats(resolvedPrivateKey);
                return {
                    publicKey: wallet.publicKey,
                    privateKey: formats.base64,
                    privateKeyHex: formats.hex,
                    privateKeyBase58: formats.base58,
                    details: {
                        ...wallet,
                        isExported: markAsExported ? true : !!wallet.isExported
                    }
                };
            });
            const privateKeysBase64 = walletsForExport.map(item => item.privateKey).filter(Boolean);
            const privateKeysHex = walletsForExport.map(item => item.privateKeyHex).filter(Boolean);
            const privateKeysBase58 = walletsForExport.map(item => item.privateKeyBase58).filter(Boolean);
            const privateKeysBase58Csv = privateKeysBase58.join(',');
            const payload = {
                exportedAt: new Date().toISOString(),
                totalSelected: walletsForExport.length,
                wallets: walletsForExport,
                privateKeys: privateKeysBase64,
                privateKeysBase64,
                privateKeysHex,
                privateKeysBase58,
                privateKeysBase58Csv
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const link = document.createElement('a');
            link.href = url;
            link.download = `selected-wallets-${stamp}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            setExportUiStatus('Download started.');

            if (markAsExported) {
                try {
                    const markRes = await fetch('/api/wallets/export', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ publicKeys: selectedPubkeys })
                    });
                    if (!markRes.ok) {
                        throw new Error(`Failed to mark exported wallets (${markRes.status})`);
                    }
                    setWallets(prev => prev.map(wallet => (
                        selectedPubkeys.includes(wallet.publicKey)
                            ? { ...wallet, isExported: true }
                            : wallet
                    )));

                    if (archiveAfterExport) {
                        const entries = selectedPubkeys.map((publicKey) => ({
                            publicKey,
                            note: (archiveNote || '').trim()
                        }));
                        const archiveRes = await fetch('/api/wallets/archive', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ entries })
                        });
                        const archivePayload = await archiveRes.json().catch(() => ({}));
                        if (!archiveRes.ok) {
                            throw new Error(archivePayload?.error || `Failed to archive wallets (${archiveRes.status})`);
                        }
                        const archivedAt = new Date().toISOString();
                        const note = (archiveNote || '').trim();
                        setWallets(prev => prev.map(wallet => (
                            selectedPubkeys.includes(wallet.publicKey)
                                ? { ...wallet, isArchived: true, archivedAt, archivedNote: note }
                                : wallet
                        )));
                    }
                } catch (markError) {
                    setTerminalLines(prev => [...prev.slice(-200), `[WARN] ${markError.message}. JSON was downloaded, but export status updates were not fully applied.`]);
                    setExportUiStatus('Downloaded, but failed to apply exported/archive updates.');
                }
            }

            setSelectedWalletKeys(new Set());
            setShowExportModal(false);
            setExportWithArchive(false);
            setExportArchiveNote('');
        } catch (error) {
            setTerminalLines(prev => [...prev.slice(-200), `[ERROR] ${error.message}`]);
            setExportUiStatus(`Export failed: ${error.message}`);
        } finally {
            setIsExporting(false);
        }
    };

    const openExportModal = () => {
        setTerminalLines(prev => [...prev.slice(-200), `[SYSTEM] Export modal requested (${selectedCount} selected).`]);
        setExportUiStatus('Export panel opened.');
        setExportWithArchive(false);
        setExportArchiveNote('');
        setShowExportModal(true);
    };

    const openArchiveModal = () => {
        const selected = [...selectedWallets];
        const notes = {};
        const applyMap = {};
        selected.forEach((wallet) => {
            notes[wallet.publicKey] = wallet.archivedNote || '';
            applyMap[wallet.publicKey] = true;
        });
        setArchiveNotesByKey(notes);
        setArchiveApplyByKey(applyMap);
        setArchiveCommonNote('');
        setArchiveUseSameNote(selected.length > 1);
        setArchiveUiStatus(`Archive panel opened (${selected.length} selected, ${selectedExportedWallets.length} exported).`);
        setShowArchiveModal(true);
    };

    const closeArchiveModal = () => {
        setShowArchiveModal(false);
        setArchiveUiStatus('Archive panel closed.');
    };

    const archiveSelectedWallets = async () => {
        try {
            if (selectedExportedWallets.length === 0) {
                setArchiveUiStatus('No exported wallets selected.');
                return;
            }

            let entries = [];
            if (archiveUseSameNote) {
                const note = archiveCommonNote.trim();
                entries = selectedExportedWallets.map(wallet => ({ publicKey: wallet.publicKey, note }));
            } else {
                entries = selectedExportedWallets
                    .filter(wallet => archiveApplyByKey[wallet.publicKey] !== false)
                    .map(wallet => ({ publicKey: wallet.publicKey, note: (archiveNotesByKey[wallet.publicKey] || '').trim() }));
            }

            if (entries.length === 0) {
                setArchiveUiStatus('No wallets selected in the archive dialog.');
                return;
            }

            setIsArchiving(true);
            setArchiveUiStatus(`Archiving ${entries.length} exported wallet${entries.length === 1 ? '' : 's'}...`);
            const res = await fetch('/api/wallets/archive', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries })
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(payload?.error || `Archive failed (${res.status})`);

            const entryMap = new Map(entries.map(entry => [entry.publicKey, entry.note]));
            const archivedAt = new Date().toISOString();
            setWallets(prev => prev.map(wallet => {
                const note = entryMap.get(wallet.publicKey);
                if (note === undefined) return wallet;
                return {
                    ...wallet,
                    isArchived: true,
                    archivedNote: note,
                    archivedAt
                };
            }));

            const skipped = Number(payload?.skippedNotExported || 0);
            const archivedCount = Number(payload?.archived || 0);
            const updatedCount = Number(payload?.updated || 0);
            setArchiveUiStatus(`Archived ${archivedCount}, updated ${updatedCount}${skipped > 0 ? `, skipped ${skipped} non-exported` : ''}.`);
            setSelectedWalletKeys(new Set());
            setShowArchiveModal(false);
        } catch (error) {
            setArchiveUiStatus(`Archive failed: ${error.message}`);
            setTerminalLines(prev => [...prev.slice(-200), `[ERROR] ${error.message}`]);
        } finally {
            setIsArchiving(false);
        }
    };

    const searchStatusText = !searchTerm
        ? ''
        : searchDebouncing
            ? `Waiting to search "${searchTerm}"...`
                : walletsLoading
                    ? `Searching for "${debouncedSearchTerm || searchTerm}"...`
                    : totalMatches === null
                        ? `Found ${wallets.length} so far for "${debouncedSearchTerm || searchTerm}" (counting total...).`
                        : totalMatches === 0
                        ? `No matches found for "${debouncedSearchTerm || searchTerm}".`
                        : wallets.length < totalMatches
                            ? `Found ${totalMatches} matches for "${debouncedSearchTerm || searchTerm}" (showing first ${wallets.length}).`
                            : `Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'} for "${debouncedSearchTerm || searchTerm}".`;

    const folderRank = (folder) => {
        if (folder === 'both') return 2;
        if (folder === 'start' || folder === 'end') return 1;
        return 0;
    };

    const folderBadgeClass = (folder) => {
        if (folder === 'both') return 'wallet-chip wallet-chip-vivid';
        if (folder === 'start' || folder === 'end') return 'wallet-chip wallet-chip-dim';
        return 'wallet-chip wallet-chip-neutral';
    };

    const sessionFindsByRarity = [...sessionFinds].sort((a, b) => {
        if (b.matchLen !== a.matchLen) return b.matchLen - a.matchLen;
        if (folderRank(b.folder) !== folderRank(a.folder)) return folderRank(b.folder) - folderRank(a.folder);
        return (b.createdAt || 0) - (a.createdAt || 0);
    });

    const visibleSessionFinds = showSettledSessionFinds
        ? sessionFindsByRarity
        : sessionFindsByRarity.filter(item => !item.expired);
    const settledCount = sessionFindsByRarity.filter(item => item.expired).length;
    const sessionExactKeySet = new Set(sessionFinds.filter(item => item.publicKey && !item.publicKey.includes('...')).map(item => item.publicKey));
    const sessionShortFingerprints = sessionFinds
        .filter(item => item.publicKey && item.publicKey.includes('...'))
        .map(item => {
            const [prefix = '', suffix = ''] = item.publicKey.split('...');
            return { prefix, suffix };
        })
        .filter(fp => fp.prefix.length >= 4 && fp.suffix.length >= 4);

    const isSessionWallet = (pubKey) => {
        if (sessionExactKeySet.has(pubKey)) return true;
        return sessionShortFingerprints.some(fp => pubKey.startsWith(fp.prefix) && pubKey.endsWith(fp.suffix));
    };

    const getLengthLabel = (wallet) => {
        if (wallet.startLen > 0 && wallet.endLen > 0) {
            return `${wallet.startLen}+${wallet.endLen}`;
        }
        return `${wallet.matchLen}`;
    };

    const renderHighlightedPubkey = (wallet) => {
        const key = wallet.publicKey || '';
        if (key.includes('...')) return key;
        const start = wallet.startMatch || '';
        const end = wallet.endMatch || '';
        const keyUpper = key.toUpperCase();
        const startUpper = start.toUpperCase();
        const endUpper = end.toUpperCase();

        if (start && end && keyUpper.startsWith(startUpper) && keyUpper.endsWith(endUpper) && key.length >= start.length + end.length) {
            const startSlice = key.slice(0, start.length);
            const middle = key.slice(start.length, key.length - end.length);
            const endSlice = key.slice(key.length - end.length);
            return (
                <>
                    <span className="match-highlight">{startSlice}</span>
                    {middle}
                    <span className="match-highlight">{endSlice}</span>
                </>
            );
        }

        if (start && keyUpper.startsWith(startUpper)) {
            const startSlice = key.slice(0, start.length);
            return (
                <>
                    <span className="match-highlight">{startSlice}</span>
                    {key.slice(start.length)}
                </>
            );
        }

        if (end && keyUpper.endsWith(endUpper)) {
            const endSlice = key.slice(key.length - end.length);
            return (
                <>
                    {key.slice(0, key.length - end.length)}
                    <span className="match-highlight">{endSlice}</span>
                </>
            );
        }

        return key;
    };

    const renderVanityWithHighlights = (wallet) => {
        const start = wallet.startMatch || '';
        const end = wallet.endMatch || '';
        if (start && end) {
            return (
                <>
                    <span className="match-highlight">{start}</span>
                    <span className="text-gray-500">...</span>
                    <span className="match-highlight">{end}</span>
                </>
            );
        }
        if (start) {
            return (
                <>
                    <span className="match-highlight">{start}</span>
                    <span className="text-gray-500">...{wallet.publicKey.slice(-4)}</span>
                </>
            );
        }
        if (end) {
            return (
                <>
                    <span className="text-gray-500">{wallet.publicKey.slice(0, 4)}...</span>
                    <span className="match-highlight">{end}</span>
                </>
            );
        }
        return wallet.vanityDisplay;
    };

    const renderSessionVanity = (wallet) => {
        const start = wallet.startMatch || '';
        const end = wallet.endMatch || '';
        if (start || end) return renderVanityWithHighlights(wallet);
        return wallet.vanityDisplay;
    };

    const renderSessionPubkey = (wallet) => {
        const start = wallet.startMatch || '';
        const end = wallet.endMatch || '';
        if (start || end) return renderHighlightedPubkey(wallet);
        return `${wallet.publicKey.slice(0, 12)}...${wallet.publicKey.slice(-8)}`;
    };

    // Connect SSE
    useEffect(() => {
        eventSourceRef.current = new EventSource('/api/sse');
        eventSourceRef.current.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'log') {
                const line = data.line || '';
                setTerminalLines(prev => [...prev.slice(-200), line]); // keep last 200 lines
                if (line.includes('Process exited') || line.includes('Session finished.')) {
                    setIsRunning(false);
                    setIsStopping(false);
                    setShowSessionSummary(true);
                }
            }
            if (data.type === 'new-wallet') {
                addToSession(data.wallet);
            }
        };
        return () => eventSourceRef.current?.close();
    }, []);

    useEffect(() => {
        const trimmed = searchTerm.trim();
        if (!trimmed) {
            setDebouncedSearchTerm('');
            setSearchDebouncing(false);
            return;
        }
        setSearchDebouncing(true);
        const timer = setTimeout(() => {
            setDebouncedSearchTerm(trimmed);
            setSearchDebouncing(false);
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [searchTerm, SEARCH_DEBOUNCE_MS]);

    // Refresh wallets when filters/search change
    useEffect(() => {
        setTotalMatches(null);
        lastCountQueryKeyRef.current = '';
        refreshWallets(debouncedSearchTerm);
    }, [minLength, typeFilter, exportedFilter, archivedFilter, nameStyleFilter, minSideLength, debouncedSearchTerm, refreshWallets]);

    // Poll wallets when running
    useEffect(() => {
        if (isStopping) {
            clearInterval(pollIntervalRef.current);
            return () => clearInterval(pollIntervalRef.current);
        }
        if (isRunning) {
            pollIntervalRef.current = setInterval(() => refreshWallets(debouncedSearchTerm), 12000);
        } else {
            clearInterval(pollIntervalRef.current);
        }
        return () => clearInterval(pollIntervalRef.current);
    }, [isRunning, isStopping, debouncedSearchTerm, refreshWallets]);

    useEffect(() => {
        if (!hasMoreWallets || walletsLoading || walletsLoadingMore) return;
        const sentinel = loadMoreSentinelRef.current;
        if (!sentinel) return;
        const observer = new IntersectionObserver((entries) => {
            const first = entries[0];
            if (!first?.isIntersecting) return;
            fetchWallets({ searchValue: debouncedSearchTerm, offset: wallets.length, append: true });
        }, {
            root: null,
            rootMargin: '300px 0px',
            threshold: 0
        });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [hasMoreWallets, walletsLoading, walletsLoadingMore, wallets.length, debouncedSearchTerm, fetchWallets]);

    useEffect(() => {
        setSelectedWalletKeys(prev => {
            const available = new Set(wallets.map(w => w.publicKey));
            const next = new Set();
            prev.forEach((pubkey) => {
                if (available.has(pubkey)) next.add(pubkey);
            });
            return next;
        });
    }, [wallets]);

    // Auto scroll terminal
    useEffect(() => {
        if (terminalRef.current) {
            terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
        }
    }, [terminalLines]);

    useEffect(() => {
        return () => {
            if (walletsFetchAbortRef.current) {
                try { walletsFetchAbortRef.current.abort(); } catch { }
            }
            if (walletCountFetchAbortRef.current) {
                try { walletCountFetchAbortRef.current.abort(); } catch { }
            }
            collapseTimersRef.current.forEach((timer) => clearTimeout(timer));
            collapseTimersRef.current.clear();
        };
    }, []);

    useEffect(() => {
        if (!showInfoPanel) return;
        fetchStats();
        const timer = setInterval(fetchStats, 20000);
        return () => clearInterval(timer);
    }, [showInfoPanel]);

    return (
        <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-6">
            <div className="max-w-7xl mx-auto">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <div>
                        <h1 className="text-5xl font-bold gold tracking-tighter">WALLETOOL</h1>
                        <p className="text-xl text-gray-400">Solana Vanity Wallet Generator + Live Dashboard</p>
                    </div>
                    <div className="flex gap-4">
                        <a href="https://github.com" target="_blank" className="text-sm gold hover:underline">View CLI Source</a>
                        <button onClick={() => window.open('/api/wallets?minLength=3', '_blank')} className="neo-btn text-sm px-4 py-2 transition">
                            Export All JSON
                        </button>
                    </div>
                </div>

                <div className="card mb-6 controls-card">
                    <div className="controls-terminal-row">
                        <div>
                            <h2 className="text-2xl gold mb-6">Farming Controls</h2>
                            <div className="space-y-6">
                                <div>
                                    <label className="block text-sm mb-2 text-gray-400">Duration (minutes) or Repeat Cycle</label>
                                    <div className="flex gap-3">
                                        <input
                                            type="number"
                                            value={minutes}
                                            onChange={(e) => setMinutes(parseInt(e.target.value) || 30)}
                                            className="neo-field flex-1 px-4 py-3"
                                        />
                                        <input
                                            type="number"
                                            placeholder="Repeat cycle"
                                            value={repeatCycle}
                                            onChange={(e) => setRepeatCycle(e.target.value)}
                                            className="neo-field flex-1 px-4 py-3"
                                        />
                                    </div>
                                </div>

                                <div className="flex gap-3">
                                    <button
                                        type="button"
                                        onClick={startFarming}
                                        disabled={isRunning || isStopping}
                                        className="flex-1 neo-btn py-4 text-lg disabled:opacity-50"
                                    >
                                        START FARMING
                                    </button>
                                    {(isRunning || isStopping) && (
                                        <button
                                            type="button"
                                            onClick={stopFarming}
                                            disabled={!isRunning || isStopping}
                                            className="flex-1 neo-btn py-4 text-lg disabled:opacity-50"
                                        >
                                            {isStopping ? 'STOPPING...' : 'STOP'}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setShowInfoPanel(prev => !prev)}
                                        className={`flex-1 py-4 text-sm ${showInfoPanel ? 'neo-btn-solid' : 'neo-btn'}`}
                                    >
                                        {showInfoPanel ? 'HIDE INFO' : 'INFORMATION'}
                                    </button>
                                </div>

                                {showInfoPanel && (
                                    <div className="stats-panel">
                                        <div className="stats-panel-head">
                                            <h4 className="gold">Collection Details</h4>
                                            <button className="session-toggle-btn" onClick={fetchStats} disabled={statsLoading}>
                                                {statsLoading ? 'Refreshing...' : 'Refresh'}
                                            </button>
                                        </div>

                                        {statsError && <div className="stats-error">{statsError}</div>}
                                        {!statsError && !stats && <div className="text-xs text-gray-500">Loading stats...</div>}
                                        {stats && (
                                            <>
                                                <div className="stats-grid">
                                                    <div className="stats-item">
                                                        <div className="stats-label">Total Wallets</div>
                                                        <div className="stats-value">{stats.totalWallets.toLocaleString()}</div>
                                                    </div>
                                                    <div className="stats-item">
                                                        <div className="stats-label">Last 24h</div>
                                                        <div className="stats-value">{stats.recent.last24h.toLocaleString()}</div>
                                                    </div>
                                                    <div className="stats-item">
                                                        <div className="stats-label">Super Rare</div>
                                                        <div className="stats-value">{stats.rarity.superRare.toLocaleString()}</div>
                                                    </div>
                                                    <div className="stats-item">
                                                        <div className="stats-label">Epic</div>
                                                        <div className="stats-value">{stats.rarity.epic.toLocaleString()}</div>
                                                    </div>
                                                    <div className="stats-item">
                                                        <div className="stats-label">Ultra Rare</div>
                                                        <div className="stats-value">{stats.rarity.ultraRare.toLocaleString()}</div>
                                                    </div>
                                                    <div className="stats-item">
                                                        <div className="stats-label">Rare</div>
                                                        <div className="stats-value">{stats.rarity.rare.toLocaleString()}</div>
                                                    </div>
                                                </div>

                                                <div className="stats-chip-row">
                                                    <span className="wallet-chip wallet-chip-dim">START {stats.byFolder.start.toLocaleString()}</span>
                                                    <span className="wallet-chip wallet-chip-dim">END {stats.byFolder.end.toLocaleString()}</span>
                                                    <span className="wallet-chip wallet-chip-vivid">BOTH {stats.byFolder.both.toLocaleString()}</span>
                                                    <span className="wallet-chip wallet-chip-neutral">AVG LEN {stats.lengths.average}</span>
                                                    <span className="wallet-chip wallet-chip-neutral">MAX LEN {stats.lengths.maxTotal}</span>
                                                </div>

                                                {stats.topExample && (
                                                    <div className="stats-top-example">
                                                        <div className="stats-label">Top Example</div>
                                                        <div className="font-mono">{stats.topExample.startMatch || stats.topExample.endMatch
                                                            ? `${stats.topExample.startMatch || stats.topExample.publicKey.slice(0, 4)}...${stats.topExample.endMatch || stats.topExample.publicKey.slice(-4)}`
                                                            : `${stats.topExample.publicKey.slice(0, 6)}...${stats.topExample.publicKey.slice(-6)}`}</div>
                                                        <div className="text-xs text-gray-500 mt-1">LEN {stats.topExample.matchLen} • {(stats.topExample.type || 'unknown').toUpperCase()}</div>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                )}

                                <div className="pt-4 border-t border-[#213255]">
                                    <p className="text-xs text-gray-500">Your original CLI runs unchanged in background.</p>
                                    <p className="text-xs text-gray-500 mt-1">Thermal protection, graceful shutdown, everything works exactly as console.</p>
                                </div>
                            </div>
                        </div>

                        <div>
                            <h3 className="text-xl gold mb-4">Live Terminal Output</h3>
                            <div ref={terminalRef} className="terminal">
                                {terminalLines.length === 0 && <div className="text-gray-600">Waiting for activity... start farming to see logs</div>}
                                {terminalLines.map((line, i) => (
                                    <div key={i}>{line}</div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                <div className="space-y-6">
                    {/* Session Finds */}
                    {sessionFinds.length > 0 && (
                        <div className="card">
                            <h3 className="text-xl gold mb-4 flex items-center gap-2">
                                <span>🔥 THIS SESSION FINDS</span>
                                <span className="text-sm text-gray-500">({visibleSessionFinds.length} visible / {sessionFinds.length} total)</span>
                            </h3>
                            <div className="session-find-actions">
                                <button className="session-toggle-btn" onClick={() => setShowSettledSessionFinds(prev => !prev)}>
                                    {showSettledSessionFinds ? 'Hide Settled' : `Show Settled (${settledCount})`}
                                </button>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {visibleSessionFinds.map(item => (
                                    <div key={item.id} className={`new-wallet bg-[#0b1022] border-2 border-[#56d6ff] rounded-2xl p-5 session-find-card ${item.expired ? 'session-find-expired' : ''}`}>
                                        <div className="session-find-main">
                                            <div className="session-headline">
                                                <div className="text-2xl font-mono gold tracking-widest">{renderSessionVanity(item)}</div>
                                                <div className="wallet-chip-row">
                                                    <span className="wallet-chip wallet-chip-neutral">LEN {getLengthLabel(item)}</span>
                                                    <span className={folderBadgeClass(item.folder)}>{(item.folder || 'unknown').toUpperCase()}</span>
                                                    <span className={`wallet-chip ${item.expired ? 'wallet-chip-settled' : 'wallet-chip-new'}`}>{item.expired ? 'SETTLED' : 'ℹ NEW'}</span>
                                                </div>
                                            </div>
                                            <div className="text-xs text-gray-300 mt-1 font-mono break-all">{renderSessionPubkey(item)}</div>
                                            <div className="text-xs text-gray-500 mt-1">{item.timestamp}</div>
                                        </div>
                                    </div>
                                ))}
                                {visibleSessionFinds.length === 0 && (
                                    <div className="text-sm text-gray-500">All session finds are settled. Click "Show Settled" to expand the full session list.</div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Wallet Table */}
                    <div className="card">
                        <h3 className="text-2xl mb-3 flex items-center gap-3">
                            <span>All Wallets <span className="text-sm text-gray-500">({filteredWallets.length} shown / {totalMatches === null ? 'counting...' : totalMatches} total matches)</span></span>
                            {(walletsLoading || walletsLoadingMore) && (
                                <span className="table-loading-inline">
                                    <span className="table-spinner" aria-hidden="true" />
                                    {walletsLoadingMore ? 'Loading more...' : 'Updating...'}
                                </span>
                            )}
                        </h3>

                        {!isRunning && showSessionSummary && sessionFindsByRarity.length > 0 && (
                            <div className="session-summary">
                                <h4 className="gold">Session Summary (sorted by rarity)</h4>
                                <div className="session-summary-list">
                                    {sessionFindsByRarity.map((item, idx) => (
                                        <div key={`summary-${item.id}`} className="session-summary-row">
                                            <span className="session-summary-rank">#{idx + 1}</span>
                                            <div className="session-summary-main">
                                                <span className="font-mono">{renderSessionVanity(item)}</span>
                                                <div className="wallet-chip-row session-summary-chips">
                                                    <span className={folderBadgeClass(item.folder)}>{(item.folder || 'unknown').toUpperCase()}</span>
                                                    <span className="wallet-chip wallet-chip-neutral">LEN {getLengthLabel(item)}</span>
                                                    <span className={`wallet-chip ${item.expired ? 'wallet-chip-settled' : 'wallet-chip-new'}`}>{item.expired ? 'SETTLED' : 'ℹ NEW'}</span>
                                                    <span className="wallet-chip wallet-chip-neutral">{item.timestamp}</span>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="wallet-table-scroll">
                            <div className="wallet-table-sticky-actions">
                                <div className="wallet-toolbar-main">
                                    <div className="wallet-toolbar-left">
                                        <select value={minLength} onChange={(e) => setMinLength(parseInt(e.target.value))} className="neo-field px-3 py-2 text-sm">
                                            {[2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>Min {n}+</option>)}
                                        </select>
                                        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="neo-field px-3 py-2 text-sm">
                                            {['all', 'start', 'end', 'both', 'single', 'addition'].map(t => (
                                                <option key={t} value={t}>{t === 'addition' ? 'X+X' : t.toUpperCase()}</option>
                                            ))}
                                        </select>
                                        <select value={exportedFilter} onChange={(e) => setExportedFilter(e.target.value)} className="neo-field px-3 py-2 text-sm">
                                            <option value="all">ALL</option>
                                            <option value="exported">EXPORTED</option>
                                            <option value="not-exported">NOT EXPORTED</option>
                                        </select>
                                        <select value={archivedFilter} onChange={(e) => setArchivedFilter(e.target.value)} className="neo-field px-3 py-2 text-sm">
                                            <option value="not-archived">ACTIVE (HIDE ARCHIVED)</option>
                                            <option value="archived">ARCHIVED ONLY</option>
                                            <option value="all">ALL (INCL ARCHIVED)</option>
                                        </select>
                                        <select value={nameStyleFilter} onChange={(e) => setNameStyleFilter(e.target.value)} className="neo-field px-3 py-2 text-sm">
                                            <option value="all">ALL NAMES</option>
                                            <option value="letters-only">LETTERS ONLY (NO 0-9)</option>
                                        </select>
                                        {typeFilter === 'addition' && (
                                            <select value={minSideLength} onChange={(e) => setMinSideLength(parseInt(e.target.value))} className="neo-field px-3 py-2 text-sm">
                                                {[1, 2, 3, 4].map(n => <option key={n} value={n}>Each side {n}+</option>)}
                                            </select>
                                        )}
                                        <input
                                            type="text"
                                            value={searchTerm}
                                            onChange={(e) => setSearchTerm(e.target.value)}
                                            placeholder={'Search term or pubkey...'}
                                            className="neo-field px-3 py-2 text-sm min-w-[220px]"
                                        />
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setTableScope('all')}
                                                className={`px-3 py-2 text-xs transition neo-btn`}
                                            >
                                                ALL
                                            </button>
                                        <button
                                            onClick={() => setTableScope('session-new')}
                                            className={`px-3 py-2 text-xs transition ${tableScope === 'session-new' ? 'neo-btn-solid' : 'neo-btn'}`}
                                        >
                                            SESSION NEW
                                        </button>
                                        <button
                                            onClick={showExportedPreset}
                                            className="px-3 py-2 text-xs transition neo-btn"
                                            type="button"
                                        >
                                            SHOW EXPORTED
                                        </button>
                                    </div>
                                </div>
                                    <div className="wallet-toolbar-right">
                                        <button
                                            onClick={toggleSelectVisible}
                                            className="neo-btn text-sm px-3 py-2 transition"
                                            disabled={filteredWallets.length === 0}
                                        >
                                            {allVisibleSelected ? 'Deselect Visible' : 'Select Visible'}
                                        </button>
                                        <button
                                            onClick={clearSelection}
                                            className="neo-btn text-sm px-3 py-2 transition"
                                            disabled={selectedCount === 0}
                                        >
                                            Clear Selection
                                        </button>
                                        <button
                                            onClick={openExportModal}
                                            type="button"
                                            className="neo-btn text-sm px-3 py-2 transition"
                                        >
                                            Export Selected ({selectedCount})
                                        </button>
                                        <button
                                            onClick={openArchiveModal}
                                            type="button"
                                            className="neo-btn text-sm px-3 py-2 transition"
                                            disabled={selectedCount === 0}
                                        >
                                            Archive Selected ({selectedExportedWallets.length}/{selectedCount})
                                        </button>
                                    </div>
                                </div>
                                <div className="text-xs text-gray-400 mt-2 min-h-[1rem]">
                                    {(walletsLoading || walletsLoadingMore) && !searchStatusText ? 'Updating table...' : searchStatusText}
                                </div>
                                <div className="text-xs text-[#d8be74] mt-1 min-h-[1rem]">{exportUiStatus}</div>
                                <div className="text-xs text-[#8ad8ff] mt-1 min-h-[1rem]">{archiveUiStatus}</div>
                                {showExportModal && (
                                    <div className="export-inline-panel">
                                        <h4 className="text-xl gold mb-3">Export Selected Wallets</h4>
                                        <p className="text-sm text-gray-300 mb-4">
                                            You are exporting {selectedCount} selected wallet{selectedCount === 1 ? '' : 's'}.
                                        </p>
                                        {selectedCount === 0 && (
                                            <p className="text-sm text-amber-300 mb-4">
                                                No wallets are currently selected. Select rows first, then export.
                                            </p>
                                        )}
                                        <label className="export-inline-option">
                                            <input
                                                type="checkbox"
                                                checked={exportWithMark}
                                                onChange={(e) => {
                                                    const checked = e.target.checked;
                                                    setExportWithMark(checked);
                                                    if (!checked) setExportWithArchive(false);
                                                }}
                                            />
                                            Mark selected wallets as EXPORTED
                                        </label>
                                        <label className="export-inline-option">
                                            <input
                                                type="checkbox"
                                                checked={exportWithArchive}
                                                disabled={!exportWithMark}
                                                onChange={(e) => setExportWithArchive(e.target.checked)}
                                            />
                                            Mark selected wallets as ARCHIVED after export
                                        </label>
                                        {exportWithArchive && (
                                            <textarea
                                                value={exportArchiveNote}
                                                onChange={(e) => setExportArchiveNote(e.target.value)}
                                                rows={3}
                                                className="neo-field px-3 py-2 text-sm w-full mb-3"
                                                placeholder="Archive note (reason, context, etc.)"
                                            />
                                        )}
                                        <div className="export-inline-actions">
                                            <button
                                                onClick={() => {
                                                    setShowExportModal(false);
                                                    setExportWithArchive(false);
                                                    setExportArchiveNote('');
                                                    setExportUiStatus('Export panel closed.');
                                                }}
                                                className="neo-btn px-4 py-2 text-sm"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={() => exportSelectedWallets(exportWithMark, exportWithArchive, exportArchiveNote)}
                                                type="button"
                                                disabled={isExporting || selectedCount === 0}
                                                className="neo-btn-solid px-4 py-2 text-sm transition"
                                            >
                                                {isExporting ? 'Exporting...' : 'Download JSON'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                                {showArchiveModal && (
                                    <div className="export-inline-panel">
                                        <h4 className="text-xl gold mb-3">Archive Exported Wallets</h4>
                                        <p className="text-sm text-gray-300 mb-4">
                                            Selected: {selectedCount} wallet{selectedCount === 1 ? '' : 's'}.
                                            Exported in selection: {selectedExportedWallets.length}.
                                        </p>
                                        {selectedExportedWallets.length === 0 && (
                                            <p className="text-sm text-amber-300 mb-4">
                                                Select exported wallets to archive them.
                                            </p>
                                        )}
                                        {selectedExportedWallets.length > 1 && (
                                            <label className="export-inline-option">
                                                <input
                                                    type="checkbox"
                                                    checked={archiveUseSameNote}
                                                    onChange={(e) => setArchiveUseSameNote(e.target.checked)}
                                                />
                                                Use same note for everyone
                                            </label>
                                        )}
                                        {(archiveUseSameNote || selectedExportedWallets.length === 1) ? (
                                            <textarea
                                                value={archiveUseSameNote ? archiveCommonNote : (archiveNotesByKey[selectedExportedWallets[0]?.publicKey] || '')}
                                                onChange={(e) => {
                                                    const value = e.target.value;
                                                    if (archiveUseSameNote) setArchiveCommonNote(value);
                                                    else {
                                                        const firstKey = selectedExportedWallets[0]?.publicKey;
                                                        if (!firstKey) return;
                                                        setArchiveNotesByKey(prev => ({ ...prev, [firstKey]: value }));
                                                    }
                                                }}
                                                rows={3}
                                                className="neo-field px-3 py-2 text-sm w-full mb-3"
                                                placeholder="Archive note (reason, context, etc.)"
                                            />
                                        ) : (
                                            <div className="archive-list">
                                                {selectedExportedWallets.map((wallet) => (
                                                    <div key={`archive-note-${wallet.publicKey}`} className="archive-item">
                                                        <label className="export-inline-option">
                                                            <input
                                                                type="checkbox"
                                                                checked={archiveApplyByKey[wallet.publicKey] !== false}
                                                                onChange={(e) => setArchiveApplyByKey(prev => ({ ...prev, [wallet.publicKey]: e.target.checked }))}
                                                            />
                                                            Archive {wallet.publicKey.slice(0, 8)}...{wallet.publicKey.slice(-6)}
                                                        </label>
                                                        <textarea
                                                            value={archiveNotesByKey[wallet.publicKey] || ''}
                                                            onChange={(e) => setArchiveNotesByKey(prev => ({ ...prev, [wallet.publicKey]: e.target.value }))}
                                                            rows={2}
                                                            className="neo-field px-3 py-2 text-sm w-full"
                                                            placeholder="Note for this wallet"
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        <div className="export-inline-actions">
                                            <button onClick={closeArchiveModal} className="neo-btn px-4 py-2 text-sm">
                                                Cancel
                                            </button>
                                            <button
                                                onClick={archiveSelectedWallets}
                                                type="button"
                                                disabled={isArchiving || selectedExportedWallets.length === 0}
                                                className="neo-btn-solid px-4 py-2 text-sm transition"
                                            >
                                                {isArchiving ? 'Archiving...' : 'Save Archive'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                            <div className="overflow-x-auto">
                                <table className="table">
                                    <thead>
                                        <tr>
                                            <th>SEL</th>
                                            <th onClick={() => handleSort('folder')}>TYPE</th>
                                            <th onClick={() => handleSort('vanityDisplay')}>VANITY</th>
                                            <th onClick={() => handleSort('matchLen')}>LENGTH</th>
                                            <th>PUBKEY (click to copy)</th>
                                            <th>GENERATED</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredWallets.map((w, i) => (
                                            <tr
                                                key={`${w.publicKey}-${i}`}
                                                className={`wallet-row ${selectedWalletKeys.has(w.publicKey) ? 'wallet-row-selected' : ''} ${isSessionWallet(w.publicKey) ? 'wallet-row-new' : ''} ${w.isExported ? 'wallet-row-exported' : ''} ${w.isArchived ? 'wallet-row-archived' : ''}`}
                                                onClick={(event) => handleRowClick(event, w.publicKey)}
                                            >
                                                <td>
                                                    <input
                                                        type="checkbox"
                                                        className="wallet-select-checkbox"
                                                        checked={selectedWalletKeys.has(w.publicKey)}
                                                        onChange={() => toggleWalletSelection(w.publicKey)}
                                                        aria-label={`Select wallet ${w.publicKey}`}
                                                    />
                                                </td>
                                                <td>
                                                    <span className={folderBadgeClass(w.folder)}>
                                                        {w.folder.toUpperCase()}
                                                    </span>
                                                </td>
                                                <td>
                                                    <div className="wallet-vanity-cell">
                                                        <div className="font-mono text-lg">{renderVanityWithHighlights(w)}</div>
                                                        {isSessionWallet(w.publicKey) && <span className="wallet-chip wallet-chip-new">ℹ NEW</span>}
                                                        {w.isExported && <span className="wallet-chip wallet-chip-exported">EXPORTED</span>}
                                                        {w.isArchived && <span className="wallet-chip wallet-chip-archived">ARCHIVED</span>}
                                                        {w.isArchived && w.archivedNote && (
                                                            <div className="text-xs text-amber-200">Note: {w.archivedNote}</div>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="font-mono">{getLengthLabel(w)}</td>
                                                <td
                                                    onClick={() => copyPubkey(w.publicKey)}
                                                    className="font-mono cursor-pointer transition break-all hover:text-[#56d6ff]"
                                                    data-row-select-ignore="true"
                                                >
                                                    {renderHighlightedPubkey(w)}
                                                </td>
                                                <td className="text-xs text-gray-400">{new Date(w.generatedAt).toLocaleString()}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                <div ref={loadMoreSentinelRef} className="h-2" aria-hidden="true" />
                                {hasMoreWallets && (
                                    <div className="text-xs text-gray-500 p-3">
                                        {walletsLoadingMore ? `Loading next ${WALLET_PAGE_SIZE} wallets...` : 'Scroll down to load more...'}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
