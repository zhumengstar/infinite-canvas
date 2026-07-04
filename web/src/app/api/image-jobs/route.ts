import { nanoid } from "nanoid";
import type { NextRequest } from "next/server";

import { readResolvedServerAiConfig, type ResolvedServerAiConfig } from "../server-ai-config-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ImageJobStatus = "queued" | "running" | "success" | "error";
type ImageJobResult = { id: string; dataUrl: string };
type ImageReferencePayload = { id?: string; name?: string; type?: string; dataUrl: string };
type ImageJobRequest = {
    action?: "generation" | "edit";
    model?: string;
    prompt?: string;
    count?: number;
    quality?: string;
    size?: string;
    systemPrompt?: string;
    references?: ImageReferencePayload[];
    mask?: ImageReferencePayload;
};
type ImageJob = {
    id: string;
    status: ImageJobStatus;
    createdAt: number;
    updatedAt: number;
    error?: string;
    result?: ImageJobResult[];
};
type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
};
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};

const JOB_TTL_MS = 30 * 60 * 1000;
const IMAGE_OUTPUT_FORMAT = "png";
const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;

const jobs = globalThis as typeof globalThis & { __infiniteCanvasImageJobs?: Map<string, ImageJob> };
const imageJobs = jobs.__infiniteCanvasImageJobs || new Map<string, ImageJob>();
jobs.__infiniteCanvasImageJobs = imageJobs;

export async function POST(request: NextRequest) {
    let payload: ImageJobRequest;
    try {
        payload = normalizeJobRequest(await request.json());
    } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : "请求参数无效" }, 400);
    }

    const job: ImageJob = { id: nanoid(), status: "queued", createdAt: Date.now(), updatedAt: Date.now() };
    imageJobs.set(job.id, job);
    cleanupJobs();

    setTimeout(() => {
        void runImageJob(job.id, payload);
    }, 0);

    return jsonResponse(publicJob(job), 202);
}

export async function GET(request: NextRequest) {
    cleanupJobs();
    const id = request.nextUrl.searchParams.get("id") || "";
    const job = imageJobs.get(id);
    if (!job) return jsonResponse({ error: "任务不存在或已过期" }, 404);
    return jsonResponse(publicJob(job));
}

async function runImageJob(id: string, payload: ImageJobRequest) {
    const job = imageJobs.get(id);
    if (!job) return;
    updateJob(job, { status: "running", error: undefined });
    try {
        const config = await readResolvedServerAiConfig();
        const result = await requestServerImage(config, payload);
        updateJob(job, { status: "success", result });
    } catch (error) {
        updateJob(job, { status: "error", error: error instanceof Error ? error.message : "生成失败" });
    }
}

async function requestServerImage(config: ResolvedServerAiConfig, payload: ImageJobRequest) {
    const endpoint = config.endpoints.image;
    const model = payload.model || config.imageModel || endpoint.models[0] || "";
    if (!endpoint.baseUrl.trim() || !endpoint.apiKey.trim()) throw new Error("服务器生图渠道未配置");
    if (!model.trim()) throw new Error("请先配置生图模型");

    const prompt = withSystemPrompt(payload.systemPrompt || "", payload.prompt || "");
    if (endpoint.apiFormat === "gemini") {
        if (payload.mask) throw new Error("Gemini 调用格式暂不支持蒙版编辑");
        const count = normalizeCount(payload.count);
        const requests = Array.from({ length: count }, () => requestGeminiImage(endpoint.baseUrl, endpoint.apiKey, model, prompt, payload.references || []));
        return (await Promise.all(requests)).flat();
    }
    return payload.action === "edit"
        ? requestOpenAiImageEdit(endpoint.baseUrl, endpoint.apiKey, model, prompt, payload)
        : requestOpenAiImageGeneration(endpoint.baseUrl, endpoint.apiKey, model, prompt, payload);
}

async function requestOpenAiImageGeneration(baseUrl: string, apiKey: string, model: string, prompt: string, payload: ImageJobRequest) {
    const quality = normalizeQuality(payload.quality || "");
    const requestSize = resolveRequestSize(quality, payload.size || "auto");
    const response = await fetch(openAiUrl(baseUrl, "/images/generations"), {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            prompt,
            n: normalizeCount(payload.count),
            ...(quality ? { quality } : {}),
            ...(requestSize ? { size: requestSize } : {}),
            response_format: "b64_json",
            output_format: IMAGE_OUTPUT_FORMAT,
        }),
        cache: "no-store",
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    return parseImagePayload((await response.json()) as ImageApiResponse);
}

async function requestOpenAiImageEdit(baseUrl: string, apiKey: string, model: string, prompt: string, payload: ImageJobRequest) {
    const quality = normalizeQuality(payload.quality || "");
    const requestSize = resolveRequestSize(quality, payload.size || "auto");
    const formData = new FormData();
    formData.set("model", model);
    formData.set("prompt", prompt);
    formData.set("n", String(normalizeCount(payload.count)));
    formData.set("response_format", "b64_json");
    formData.set("output_format", IMAGE_OUTPUT_FORMAT);
    if (quality) formData.set("quality", quality);
    if (requestSize) formData.set("size", requestSize);
    for (const reference of payload.references || []) {
        formData.append("image", dataUrlToBlob(reference.dataUrl, reference.type), reference.name || "reference.png");
    }
    if (payload.mask) formData.set("mask", dataUrlToBlob(payload.mask.dataUrl, payload.mask.type), payload.mask.name || "mask.png");

    const response = await fetch(openAiUrl(baseUrl, "/images/edits"), {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        cache: "no-store",
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    return parseImagePayload((await response.json()) as ImageApiResponse);
}

async function requestGeminiImage(baseUrl: string, apiKey: string, model: string, prompt: string, references: ImageReferencePayload[]) {
    const parts: GeminiPart[] = [{ text: prompt }, ...references.map((reference) => dataUrlToGeminiPart(reference.dataUrl))];
    const response = await fetch(geminiApiUrl(baseUrl, model), {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
        cache: "no-store",
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    return parseGeminiImagePayload((await response.json()) as GeminiPayload);
}

function normalizeJobRequest(input: unknown): ImageJobRequest {
    if (!input || typeof input !== "object") throw new Error("请求参数无效");
    const value = input as ImageJobRequest;
    const prompt = String(value.prompt || "").trim();
    if (!prompt) throw new Error("请输入提示词");
    return {
        action: value.action === "edit" ? "edit" : "generation",
        model: String(value.model || "").trim(),
        prompt,
        count: normalizeCount(value.count),
        quality: String(value.quality || "auto"),
        size: String(value.size || "auto"),
        systemPrompt: String(value.systemPrompt || ""),
        references: Array.isArray(value.references) ? value.references.filter((item) => item?.dataUrl).map(normalizeReference) : [],
        mask: value.mask?.dataUrl ? normalizeReference(value.mask) : undefined,
    };
}

function normalizeReference(reference: ImageReferencePayload): ImageReferencePayload {
    return {
        id: String(reference.id || nanoid()),
        name: String(reference.name || "reference.png"),
        type: String(reference.type || reference.dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png"),
        dataUrl: String(reference.dataUrl || ""),
    };
}

function normalizeCount(count: unknown) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
}

function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;
    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        longSide = Math.floor(Math.sqrt(targetPixels * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }
    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseImageRatio(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const width = Number(parts[0]);
    const height = Number(parts[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("图像比例必须是正数，例如 9:16");
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    return { width, height };
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图像尺寸必须是正整数，例如 1024x1024");
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error("图像尺寸的宽高必须是 16 的倍数，请调整尺寸");
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error("图像尺寸最长边不能超过 3840px，请调整尺寸");
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error("图像总像素需在 655360 到 8294400 之间，请调整尺寸");
}

function parseImagePayload(payload: ImageApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "请求失败");
    if (payload.error?.message) throw new Error(payload.error.message);
    const images = payload.data?.map(resolveImageDataUrl).filter((value): value is string => Boolean(value)).map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new Error("接口没有返回图片");
    return images;
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) return `data:image/png;base64,${item.b64_json}`;
    if (typeof item.url === "string" && item.url) return item.url;
    return null;
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new Error("Gemini 接口没有返回图片");
    return images;
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return readStatusError(response.status, fallback);
    try {
        const payload = JSON.parse(text) as ImageApiResponse;
        return payload.msg || payload.error?.message || readStatusError(response.status, fallback);
    } catch {
        return text.slice(0, 300) || readStatusError(response.status, fallback);
    }
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}：${status}` : fallback;
}

function withSystemPrompt(systemPrompt: string, prompt: string) {
    const value = systemPrompt.trim();
    return value ? `${value}\n\n${prompt}` : prompt;
}

function openAiUrl(baseUrl: string, path: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    return `${normalized}${normalized.toLowerCase().endsWith("/v1") ? "" : "/v1"}${path}`;
}

function geminiApiUrl(baseUrl: string, model: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    const lower = normalized.toLowerCase();
    const apiBase = lower.endsWith("/v1") || lower.endsWith("/v1beta") ? normalized : `${normalized}/v1beta`;
    return `${apiBase}/models/${encodeURIComponent(model.trim().replace(/^models\//, ""))}:generateContent`;
}

function dataUrlToGeminiPart(dataUrl: string): GeminiPart {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: dataUrl, mimeType: "image/png" } };
}

function dataUrlToBlob(dataUrl: string, fallbackType?: string) {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) throw new Error("图片引用必须是 data URL");
    return new Blob([Buffer.from(match[2], "base64")], { type: match[1] || fallbackType || "image/png" });
}

function updateJob(job: ImageJob, patch: Partial<ImageJob>) {
    Object.assign(job, patch, { updatedAt: Date.now() });
}

function publicJob(job: ImageJob) {
    return {
        id: job.id,
        status: job.status,
        error: job.error,
        result: job.result,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
    };
}

function cleanupJobs() {
    const now = Date.now();
    imageJobs.forEach((job, id) => {
        if (now - job.updatedAt > JOB_TTL_MS) imageJobs.delete(id);
    });
}

function jsonResponse(body: unknown, status = 200) {
    return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
