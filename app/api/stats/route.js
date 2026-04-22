// app/api/stats/route.js
import { getWalletStats } from '../../../lib/sqlite_storage';

export const dynamic = 'force-dynamic';

let cached = null;
let cachedAt = 0;
const CACHE_MS = 15000;

export async function GET() {
    const now = Date.now();
    if (cached && (now - cachedAt) < CACHE_MS) {
        return Response.json(cached, {
            headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' }
        });
    }

    const stats = await getWalletStats();
    cached = stats;
    cachedAt = now;

    return Response.json(stats, {
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' }
    });
}
