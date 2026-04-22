import { markWalletsArchived } from '../../../../lib/sqlite_storage';

export const dynamic = 'force-dynamic';

export async function POST(request) {
    try {
        const body = await request.json();
        const entries = Array.isArray(body?.entries) ? body.entries : [];
        const result = await markWalletsArchived(entries);
        return Response.json(result, {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate'
            }
        });
    } catch (error) {
        return Response.json(
            { error: error?.message || 'Failed to archive wallets' },
            { status: 500 }
        );
    }
}
