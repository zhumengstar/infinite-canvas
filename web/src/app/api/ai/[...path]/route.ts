import type { NextRequest } from "next/server";
import { readResolvedServerAiConfig } from "../../server-ai-config-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hopByHopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

type RouteContext = {
    params: Promise<{ path?: string[] }> | { path?: string[] };
};

export async function GET(request: NextRequest, context: RouteContext) {
    return proxyAiRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
    return proxyAiRequest(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
    return proxyAiRequest(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
    return proxyAiRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
    return proxyAiRequest(request, context);
}

export async function HEAD(request: NextRequest, context: RouteContext) {
    return proxyAiRequest(request, context);
}

async function proxyAiRequest(request: NextRequest, context: RouteContext) {
    const serverConfig = await readResolvedServerAiConfig();
    const baseUrl = serverConfig.baseUrl.trim().replace(/\/+$/, "");
    const apiKey = serverConfig.apiKey.trim();
    if (!baseUrl || !apiKey) return new Response("Server AI proxy is not configured", { status: 503 });

    let target: URL;
    try {
        const params = await context.params;
        const pathParts = params.path || [];
        const path = normalizeTargetPath(baseUrl, pathParts);
        target = new URL(`${baseUrl}/${path}${request.nextUrl.search}`);
    } catch {
        return new Response("Invalid AI proxy target", { status: 400 });
    }

    const headers = requestHeaders(request.headers, apiKey);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const response = await fetch(target, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
        cache: "no-store",
        redirect: "manual",
    });

    return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response.headers),
    });
}

function normalizeTargetPath(baseUrl: string, pathParts: string[]) {
    const parts = [...pathParts];
    const lowerBaseUrl = baseUrl.toLowerCase();
    const firstPart = parts[0]?.toLowerCase();
    if ((lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3")) && (firstPart === "v1" || firstPart === "api")) {
        parts.shift();
        if (firstPart === "api" && parts[0] === "v3") parts.shift();
        if (firstPart === "api" && parts[0] === "plan" && parts[1] === "v3") parts.splice(0, 2);
    }
    return parts.map(encodeURIComponent).join("/");
}

function requestHeaders(incoming: Headers, apiKey: string) {
    const headers = new Headers();
    incoming.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (hopByHopHeaders.has(lowerKey)) return;
        if (lowerKey === "authorization" || lowerKey === "x-goog-api-key") return;
        headers.set(key, value);
    });
    headers.set("Authorization", `Bearer ${apiKey}`);
    return headers;
}

function responseHeaders(incoming: Headers) {
    const headers = new Headers();
    incoming.forEach((value, key) => {
        if (hopByHopHeaders.has(key.toLowerCase())) return;
        headers.set(key, value);
    });
    headers.set("Cache-Control", "no-store");
    return headers;
}
