import { createModelChannel, type AiConfig, type ModelEndpointKey } from "@/stores/use-config-store";

type ServerEndpointConfig = {
    apiFormat: "openai";
    proxyBaseUrl: string;
    models: string[];
};

export type ServerConfig = {
    enabled: boolean;
    channelName: string;
    apiFormat: "openai";
    proxyBaseUrl: string;
    endpoints?: Partial<Record<ModelEndpointKey, ServerEndpointConfig>>;
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

export const SERVER_CHANNEL_ID = "server";
export const SERVER_API_KEY_PLACEHOLDER = "server-side";

type UpdateConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

export function applyServerConfig(updateConfig: UpdateConfig, serverConfig: ServerConfig) {
    if (!serverConfig.enabled) return;
    const channelModels = uniqueModels(serverConfig.models);
    const endpoints = {
        image: createServerEndpoint(serverConfig, "image", serverConfig.imageModels),
        text: createServerEndpoint(serverConfig, "text", serverConfig.textModels),
        video: createServerEndpoint(serverConfig, "video", serverConfig.videoModels),
    };
    const channel = createModelChannel({
        id: SERVER_CHANNEL_ID,
        name: serverConfig.channelName || "服务器渠道",
        baseUrl: serverConfig.proxyBaseUrl || "/api/ai",
        apiKey: SERVER_API_KEY_PLACEHOLDER,
        apiFormat: serverConfig.apiFormat || "openai",
        models: channelModels,
        endpoints,
    });
    const modelValue = (model: string) => (model ? `${SERVER_CHANNEL_ID}::${model}` : "");
    const imageModels = uniqueModels([...(serverConfig.imageModels || []), ...(serverConfig.endpoints?.image?.models || [])]).map(modelValue).filter(Boolean);
    const videoModels = uniqueModels([...(serverConfig.videoModels || []), ...(serverConfig.endpoints?.video?.models || [])]).map(modelValue).filter(Boolean);
    const textModels = uniqueModels([...(serverConfig.textModels || []), ...(serverConfig.endpoints?.text?.models || [])]).map(modelValue).filter(Boolean);
    const audioModels = uniqueModels(serverConfig.audioModels).map(modelValue).filter(Boolean);
    const models = channelModels.map(modelValue).filter(Boolean);

    updateConfig("channels", [channel]);
    updateConfig("baseUrl", channel.baseUrl);
    updateConfig("apiKey", channel.apiKey);
    updateConfig("apiFormat", channel.apiFormat);
    updateConfig("models", models);
    updateConfig("imageModels", imageModels);
    updateConfig("videoModels", videoModels);
    updateConfig("textModels", textModels);
    updateConfig("audioModels", audioModels);
    updateConfig("imageModel", normalizeServerDefault(serverConfig.imageModel, imageModels));
    updateConfig("videoModel", normalizeServerDefault(serverConfig.videoModel, videoModels));
    updateConfig("textModel", normalizeServerDefault(serverConfig.textModel, textModels));
    updateConfig("audioModel", normalizeServerDefault(serverConfig.audioModel, audioModels));
    updateConfig("model", normalizeServerDefault(serverConfig.imageModel, imageModels) || models[0] || "");
}

function createServerEndpoint(serverConfig: ServerConfig, key: ModelEndpointKey, fallbackModels: string[]) {
    const endpoint = serverConfig.endpoints?.[key];
    return {
        apiFormat: endpoint?.apiFormat || serverConfig.apiFormat || "openai",
        baseUrl: endpoint?.proxyBaseUrl || `${serverConfig.proxyBaseUrl || "/api/ai"}/${key}`,
        apiKey: SERVER_API_KEY_PLACEHOLDER,
        models: uniqueModels(endpoint?.models?.length ? endpoint.models : fallbackModels),
    };
}

function normalizeServerDefault(model: string, options: string[]) {
    const value = model ? `${SERVER_CHANNEL_ID}::${model}` : "";
    return options.includes(value) ? value : options[0] || "";
}

function uniqueModels(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}
