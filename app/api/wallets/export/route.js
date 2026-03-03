import { markWalletsExported } from '../../../../lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(request) {
    try {
        const body = await request.json();
        const publicKeys = Array.isArray(body?.publicKeys) ? body.publicKeys : [];
        const result = markWalletsExported(publicKeys);
        return Response.json(result, {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate'
            }
        });
    } catch (error) {
        return Response.json(
            { error: error?.message || 'Failed to mark exported wallets' },
            { status: 500 }
        );
    }
}
