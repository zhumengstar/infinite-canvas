import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxCachedImages = 200;
const maxImageBytes = 10 * 1024 * 1024;
const cacheTtlMs = 1000 * 60 * 60 * 24;
const imageCache = new Map<string, { body: ArrayBuffer; contentType: string; fetchedAt: number }>();

export async function GET(request: NextRequest) {
    const rawUrl = request.nextUrl.searchParams.get("url") || "";
    const sourceUrl = parseSourceUrl(rawUrl);
    if (!sourceUrl) return new Response("Invalid image URL", { status: 400 });

    const cached = imageCache.get(sourceUrl.href);
    if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) return imageResponse(cached.body, cached.contentType);

    const upstream = await fetch(sourceUrl, {
        cache: "no-store",
        headers: {
            accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            referer: `${sourceUrl.protocol}//${sourceUrl.hostname}/`,
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        },
    }).catch(() => null);

    if (!upstream) return new Response("Image fetch failed", { status: 502 });
    if (!upstream.ok) return new Response("Image fetch failed", { status: upstream.status });
    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) return new Response("Upstream is not an image", { status: 415 });

    const contentLength = Number(upstream.headers.get("content-length") || 0);
    if (contentLength > maxImageBytes) return new Response("Image is too large", { status: 413 });

    const body = await upstream.arrayBuffer();
    if (body.byteLength > maxImageBytes) return new Response("Image is too large", { status: 413 });

    imageCache.set(sourceUrl.href, { body, contentType, fetchedAt: Date.now() });
    while (imageCache.size > maxCachedImages) {
        const firstKey = imageCache.keys().next().value;
        if (!firstKey) break;
        imageCache.delete(firstKey);
    }

    return imageResponse(body, contentType);
}

function parseSourceUrl(value: string) {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) return null;
        return url;
    } catch {
        return null;
    }
}

function imageResponse(body: ArrayBuffer, contentType: string) {
    return new Response(body, {
        headers: {
            "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
            "content-type": contentType,
        },
    });
}
