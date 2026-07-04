import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ServerEndpointKey = "image" | "text" | "video";

export type PersistedServerEndpointConfig = {
    apiFormat?: "openai";
    baseUrl?: string;
    apiKey?: string;
    models?: string[];
};

export type PublicServerEndpointConfig = {
    apiFormat: "openai";
    proxyBaseUrl: string;
    models: string[];
};

export type ResolvedServerEndpointConfig = PublicServerEndpointConfig & {
    baseUrl: string;
    apiKey: string;
};

export type PersistedServerAiConfig = {
    enabled?: boolean;
    channelName?: string;
    apiFormat?: "openai";
    baseUrl?: string;
    apiKey?: string;
    models?: string[];
    endpoints?: Partial<Record<ServerEndpointKey, PersistedServerEndpointConfig>>;
    imageModels?: string[];
    videoModels?: string[];
    textModels?: string[];
    audioModels?: string[];
    imageModel?: string;
    videoModel?: string;
    textModel?: string;
    audioModel?: string;
};

export type PublicServerAiConfig = {
    enabled: boolean;
    channelName: string;
    apiFormat: "openai";
    proxyBaseUrl: string;
    endpoints: Record<ServerEndpointKey, PublicServerEndpointConfig>;
    models: string[];
    imageModels: string[];
    videoModels: string[];
    textModels: string[];
    audioModels: string[];
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
};

export type ResolvedServerAiConfig = PublicServerAiConfig & {
    baseUrl: string;
    apiKey: string;
    endpoints: Record<ServerEndpointKey, ResolvedServerEndpointConfig>;
};

const endpointKeys: ServerEndpointKey[] = ["image", "text", "video"];
const defaultImageModels = ["gpt-image-2"];
const defaultVideoModels = ["grok-imagine-video"];
const defaultTextModels = ["gpt-5.5"];
const defaultAudioModels = ["gpt-4o-mini-tts"];

export async function readResolvedServerAiConfig(): Promise<ResolvedServerAiConfig> {
    const persisted = await readPersistedServerAiConfig();
    const hasEndpointConfig = Boolean(persisted.endpoints);
    const legacyBaseUrl = firstValue(hasEndpointConfig ? undefined : persisted.baseUrl, process.env.CANVAS_AI_BASE_URL);
    const legacyApiKey = firstValue(hasEndpointConfig ? undefined : persisted.apiKey, process.env.CANVAS_AI_API_KEY);
    const imageModels = withDefault(splitValues(persisted.imageModels?.length ? persisted.imageModels : persisted.endpoints?.image?.models, "CANVAS_IMAGE_MODELS", defaultImageModels), persisted.imageModel || process.env.CANVAS_DEFAULT_IMAGE_MODEL);
    const videoModels = withDefault(splitValues(persisted.videoModels?.length ? persisted.videoModels : persisted.endpoints?.video?.models, "CANVAS_VIDEO_MODELS", defaultVideoModels), persisted.videoModel || process.env.CANVAS_DEFAULT_VIDEO_MODEL);
    const textModels = withDefault(splitValues(persisted.textModels?.length ? persisted.textModels : persisted.endpoints?.text?.models, "CANVAS_TEXT_MODELS", defaultTextModels), persisted.textModel || process.env.CANVAS_DEFAULT_TEXT_MODEL);
    const audioModels = withDefault(splitValues(persisted.audioModels, "CANVAS_AUDIO_MODELS", defaultAudioModels), persisted.audioModel || process.env.CANVAS_DEFAULT_AUDIO_MODEL);
    const models = unique([...imageModels, ...videoModels, ...textModels, ...audioModels, ...splitValues(persisted.models, "CANVAS_MODELS", [])]);
    const endpoints: Record<ServerEndpointKey, ResolvedServerEndpointConfig> = {
        image: resolveEndpoint("image", persisted.endpoints?.image, legacyBaseUrl, legacyApiKey, imageModels),
        text: resolveEndpoint("text", persisted.endpoints?.text, legacyBaseUrl, legacyApiKey, textModels),
        video: resolveEndpoint("video", persisted.endpoints?.video, legacyBaseUrl, legacyApiKey, videoModels),
    };
    const firstEndpoint = endpointKeys.map((key) => endpoints[key]).find((endpoint) => endpoint.baseUrl && endpoint.apiKey);
    const enabledByPersisted = persisted.enabled !== false && Boolean(firstEndpoint) && (Boolean(persisted.baseUrl && persisted.apiKey) || endpointKeys.some((key) => Boolean(persisted.endpoints?.[key]?.baseUrl && persisted.endpoints?.[key]?.apiKey)));
    const enabledByEnv = envBool("CANVAS_SERVER_AI_ENABLED") && Boolean(process.env.CANVAS_AI_BASE_URL && process.env.CANVAS_AI_API_KEY);

    return {
        enabled: Boolean((enabledByPersisted || enabledByEnv) && firstEndpoint),
        channelName: persisted.channelName || process.env.CANVAS_AI_CHANNEL_NAME || "服务器渠道",
        apiFormat: "openai",
        proxyBaseUrl: "/api/ai",
        endpoints,
        models,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        imageModel: persisted.imageModel || process.env.CANVAS_DEFAULT_IMAGE_MODEL || imageModels[0] || models[0] || "",
        videoModel: persisted.videoModel || process.env.CANVAS_DEFAULT_VIDEO_MODEL || videoModels[0] || models[0] || "",
        textModel: persisted.textModel || process.env.CANVAS_DEFAULT_TEXT_MODEL || textModels[0] || models[0] || "",
        audioModel: persisted.audioModel || process.env.CANVAS_DEFAULT_AUDIO_MODEL || audioModels[0] || models[0] || "",
        baseUrl: firstEndpoint?.baseUrl || legacyBaseUrl,
        apiKey: firstEndpoint?.apiKey || legacyApiKey,
    };
}

export function toPublicServerAiConfig(config: ResolvedServerAiConfig): PublicServerAiConfig {
    return {
        enabled: config.enabled,
        channelName: config.channelName,
        apiFormat: config.apiFormat,
        proxyBaseUrl: config.proxyBaseUrl,
        endpoints: {
            image: publicEndpoint(config.endpoints.image),
            text: publicEndpoint(config.endpoints.text),
            video: publicEndpoint(config.endpoints.video),
        },
        models: config.models,
        imageModels: config.imageModels,
        videoModels: config.videoModels,
        textModels: config.textModels,
        audioModels: config.audioModels,
        imageModel: config.imageModel,
        videoModel: config.videoModel,
        textModel: config.textModel,
        audioModel: config.audioModel,
    };
}

export async function saveServerAiConfig(input: PersistedServerAiConfig) {
    const legacyBaseUrl = input.baseUrl?.trim().replace(/\/+$/, "") || "";
    const legacyApiKey = input.apiKey?.trim() || "";
    const inputEndpoints = input.endpoints || {};
    const endpoints: Partial<Record<ServerEndpointKey, PersistedServerEndpointConfig>> = {};

    for (const key of endpointKeys) {
        const endpointInput = inputEndpoints[key];
        const baseUrl = endpointInput?.baseUrl?.trim().replace(/\/+$/, "") || legacyBaseUrl;
        const apiKey = endpointInput?.apiKey?.trim() || legacyApiKey;
        const hasLegacyFallback = !input.endpoints && Boolean(legacyBaseUrl && legacyApiKey);
        const hasAnyValue = Boolean(endpointInput?.apiKey || endpointInput?.models?.length || hasLegacyFallback);
        if (!hasAnyValue) continue;
        if (!baseUrl) throw new Error(`请填写${endpointLabel(key)} Base URL`);
        if (!apiKey) throw new Error(`请填写${endpointLabel(key)} API Key`);
        endpoints[key] = {
            apiFormat: "openai",
            baseUrl,
            apiKey,
            models: unique(endpointInput?.models || []),
        };
    }

    if (!endpointKeys.some((key) => endpoints[key]?.baseUrl && endpoints[key]?.apiKey)) {
        throw new Error("请至少填写一个模型地址和 API Key");
    }

    const normalized: PersistedServerAiConfig = {
        enabled: input.enabled !== false,
        channelName: input.channelName?.trim() || "服务器渠道",
        apiFormat: "openai",
        baseUrl: legacyBaseUrl || firstSavedEndpoint(endpoints)?.baseUrl || "",
        apiKey: legacyApiKey || firstSavedEndpoint(endpoints)?.apiKey || "",
        endpoints,
        models: unique(input.models || []),
        imageModels: unique(input.imageModels || endpoints.image?.models || []),
        videoModels: unique(input.videoModels || endpoints.video?.models || []),
        textModels: unique(input.textModels || endpoints.text?.models || []),
        audioModels: unique(input.audioModels || []),
        imageModel: input.imageModel?.trim() || "",
        videoModel: input.videoModel?.trim() || "",
        textModel: input.textModel?.trim() || "",
        audioModel: input.audioModel?.trim() || "",
    };

    for (const key of endpointKeys) {
        const endpoint = normalized.endpoints?.[key];
        if (!endpoint) continue;
        if (!endpoint.models?.length) {
            endpoint.models = await fetchOpenAiModelIds(endpoint.baseUrl || "", endpoint.apiKey || "").catch(() => []);
        }
    }

    normalized.imageModels = withDefault(normalized.imageModels?.length ? normalized.imageModels : filterModels(normalized.endpoints?.image?.models || normalized.models || [], "image"), normalized.imageModel || undefined);
    normalized.videoModels = withDefault(normalized.videoModels?.length ? normalized.videoModels : filterModels(normalized.endpoints?.video?.models || normalized.models || [], "video"), normalized.videoModel || undefined);
    normalized.textModels = withDefault(normalized.textModels?.length ? normalized.textModels : filterModels(normalized.endpoints?.text?.models || normalized.models || [], "text"), normalized.textModel || undefined);
    normalized.audioModels = withDefault(normalized.audioModels?.length ? normalized.audioModels : defaultAudioModels, normalized.audioModel || undefined);
    if (normalized.endpoints?.image) normalized.endpoints.image.models = normalized.imageModels;
    if (normalized.endpoints?.video) normalized.endpoints.video.models = normalized.videoModels;
    if (normalized.endpoints?.text) normalized.endpoints.text.models = normalized.textModels;
    normalized.models = unique([...(normalized.models || []), ...normalized.imageModels, ...normalized.videoModels, ...normalized.textModels, ...normalized.audioModels]);
    normalized.imageModel = normalized.imageModel || normalized.imageModels[0] || "";
    normalized.videoModel = normalized.videoModel || normalized.videoModels[0] || "";
    normalized.textModel = normalized.textModel || normalized.textModels[0] || "";
    normalized.audioModel = normalized.audioModel || normalized.audioModels[0] || "";

    const filePath = serverConfigPath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return readResolvedServerAiConfig();
}

async function readPersistedServerAiConfig(): Promise<PersistedServerAiConfig> {
    try {
        const text = await readFile(serverConfigPath(), "utf8");
        const parsed = JSON.parse(text) as PersistedServerAiConfig;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function serverConfigPath() {
    return process.env.CANVAS_SERVER_CONFIG_PATH || "/data/server-ai-config.json";
}

function resolveEndpoint(key: ServerEndpointKey, endpoint: PersistedServerEndpointConfig | undefined, legacyBaseUrl: string, legacyApiKey: string, models: string[]): ResolvedServerEndpointConfig {
    return {
        apiFormat: "openai",
        proxyBaseUrl: `/api/ai/${key}`,
        baseUrl: firstValue(endpoint?.baseUrl, legacyBaseUrl),
        apiKey: firstValue(endpoint?.apiKey, legacyApiKey),
        models: unique(endpoint?.models?.length ? endpoint.models : models),
    };
}

function publicEndpoint(endpoint: ResolvedServerEndpointConfig): PublicServerEndpointConfig {
    return {
        apiFormat: endpoint.apiFormat,
        proxyBaseUrl: endpoint.proxyBaseUrl,
        models: endpoint.models,
    };
}

function firstSavedEndpoint(endpoints: Partial<Record<ServerEndpointKey, PersistedServerEndpointConfig>>) {
    return endpointKeys.map((key) => endpoints[key]).find((endpoint) => endpoint?.baseUrl && endpoint.apiKey);
}

function firstValue(...values: Array<string | undefined>) {
    return values.map((value) => value?.trim() || "").find(Boolean) || "";
}

function envBool(name: string) {
    const value = (process.env[name] || "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
}

function splitValues(value: string[] | undefined, envName: string, fallback: string[]) {
    if (value?.length) return unique(value);
    const envValue = process.env[envName];
    if (!envValue) return fallback;
    const items = envValue
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
    return items.length ? unique(items) : fallback;
}

function unique(items: string[]) {
    return Array.from(new Set(items.map((item) => modelName(item).trim()).filter(Boolean)));
}

function withDefault(items: string[], defaultModel?: string) {
    return unique([defaultModel || "", ...items]);
}

function modelName(value: string) {
    return value.includes("::") ? value.split("::").pop() || value : value;
}

function filterModels(models: string[], capability: "image" | "video" | "text" | "audio") {
    const values = unique(models.map(modelName));
    return values.filter((model) => {
        const value = model.toLowerCase();
        const isVideo = value.includes("seedance") || value.includes("video") || value.includes("sora") || value.includes("veo") || value.includes("kling") || value.includes("wan") || value.includes("hailuo");
        const isAudio = value.includes("audio") || value.includes("tts") || value.includes("speech") || value.includes("voice") || value.includes("music") || value.includes("sound");
        const isImage = !isVideo && !isAudio && (value.includes("seedream") || value.includes("gpt-image") || value.includes("image") || value.includes("dall-e") || value.includes("dalle") || value.includes("imagen") || value.includes("flux") || value.includes("sdxl") || value.includes("stable-diffusion") || value.includes("midjourney"));
        if (capability === "image") return isImage;
        if (capability === "video") return isVideo;
        if (capability === "audio") return isAudio;
        return !isImage && !isVideo && !isAudio;
    });
}

async function fetchOpenAiModelIds(baseUrl: string, apiKey: string) {
    const response = await fetch(buildApiUrl(baseUrl, "/models"), {
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
        cache: "no-store",
    });
    if (!response.ok) throw new Error("读取模型失败");
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    return unique((data.data || []).map((item) => item.id || ""));
}

function buildApiUrl(baseUrl: string, path: string) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

function endpointLabel(key: ServerEndpointKey) {
    if (key === "image") return "图片";
    if (key === "video") return "视频";
    return "文本";
}
