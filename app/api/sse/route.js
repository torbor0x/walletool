// app/api/sse/route.js
export const dynamic = 'force-dynamic';

export async function GET() {
    const stream = new ReadableStream({
        start(controller) {
            global.broadcastLog = (line) => {
                controller.enqueue(`data: ${JSON.stringify({ type: 'log', line })}\n\n`);
            };
            global.broadcastNewWallet = (wallet) => {
                controller.enqueue(`data: ${JSON.stringify({ type: 'new-wallet', wallet })}\n\n`);
            };
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
}
