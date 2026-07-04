import { createModelChannel, type AiConfig } from "@/stores/use-config-store";

export type ServerConfig = {
    enabled: boolean;
    channelName: string;
    apiFormat: "openai";
    proxyBaseUrl: string;
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
    const channel = createModelChannel({
        id: SERVER_CHANNEL_ID,
        name: serverConfig.channelName || "服务器渠道",
        baseUrl: serverConfig.proxyBaseUrl || "/api/ai",
        apiKey: SERVER_API_KEY_PLACEHOLDER,
        apiFormat: serverConfig.apiFormat || "openai",
        models: channelModels,
    });
    const modelValue = (model: string) => (model ? `${SERVER_CHANNEL_ID}::${model}` : "");
    const imageModels = uniqueModels(serverConfig.imageModels).map(modelValue).filter(Boolean);
    const videoModels = uniqueModels(serverConfig.videoModels).map(modelValue).filter(Boolean);
    const textModels = uniqueModels(serverConfig.textModels).map(modelValue).filter(Boolean);
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

function normalizeServerDefault(model: string, options: string[]) {
    const value = model ? `${SERVER_CHANNEL_ID}::${model}` : "";
    return options.includes(value) ? value : options[0] || "";
}

function uniqueModels(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}
