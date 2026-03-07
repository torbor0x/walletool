// app/api/wallets/route.js
import { getFilteredWallets } from '../../../lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(request) {
    try {
        const { searchParams } = new URL(request.url);
        const minLengthRaw = parseInt(searchParams.get('minLength'), 10);
        const minLength = Number.isFinite(minLengthRaw) ? Math.max(2, minLengthRaw) : 3;
        const type = searchParams.get('type') || null;
        const minSideLengthRaw = parseInt(searchParams.get('minSideLength'), 10);
        const minSideLength = Number.isFinite(minSideLengthRaw) ? Math.max(1, minSideLengthRaw) : 2;
        const search = searchParams.get('search') || '';
        const exportedFilterRaw = (searchParams.get('exported') || 'all').toLowerCase();
        const exportedFilter = ['all', 'exported', 'not-exported'].includes(exportedFilterRaw)
            ? exportedFilterRaw
            : 'all';
        const nameStyleRaw = (searchParams.get('nameStyle') || 'all').toLowerCase();
        const nameStyleFilter = ['all', 'letters-only'].includes(nameStyleRaw)
            ? nameStyleRaw
            : 'all';
        const archivedFilterRaw = (searchParams.get('archived') || 'not-archived').toLowerCase();
        const archivedFilter = ['all', 'archived', 'not-archived'].includes(archivedFilterRaw)
            ? archivedFilterRaw
            : 'not-archived';
        const limitRaw = parseInt(searchParams.get('limit') || '1000', 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 5000) : 1000;
        const offsetRaw = parseInt(searchParams.get('offset') || '0', 10);
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
        const includeTotal = searchParams.get('includeTotal') === '1';
        const includePrivateKeys = searchParams.get('includePrivateKeys') === '1';

        const { wallets, totalMatches } = getFilteredWallets(
            minLength,
            type === 'all' ? null : type,
            search,
            limit,
            minSideLength,
            includePrivateKeys,
            exportedFilter,
            nameStyleFilter,
            archivedFilter,
            true,
            offset,
            includeTotal
        );
        return Response.json({
            wallets,
            totalMatches,
            returnedCount: wallets.length,
            limit,
            offset
        }, {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate'
            }
        });
    } catch (error) {
        console.error('Wallet API failed:', error?.message || error);
        return Response.json([], {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'X-Wallets-Error': error?.message || 'unknown'
            }
        });
    }
}
