import { readResolvedServerAiConfig, saveServerAiConfig, toPublicServerAiConfig, type PersistedServerAiConfig } from "../server-ai-config-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    return Response.json(toPublicServerAiConfig(await readResolvedServerAiConfig()), {
        headers: {
            "Cache-Control": "no-store",
        },
    });
}

export async function POST(request: Request) {
    try {
        const body = (await request.json()) as PersistedServerAiConfig;
        const config = await saveServerAiConfig(body);
        return Response.json(toPublicServerAiConfig(config), {
            headers: {
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "保存服务器配置失败" }, { status: 400 });
    }
}
