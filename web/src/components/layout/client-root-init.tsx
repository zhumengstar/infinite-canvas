import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { useImageWorkbenchStore } from "@/stores/use-image-workbench-store";
import { fetchChannelModels } from "@/services/api/image";
import {
    guessApiFormat,
    guessCapability,
    modelOptionsFromChannels,
    normalizeChannelModels,
    normalizeModelOptionValue,
    selectableModelsByCapability,
    type AiConfig,
    type ModelCapability,
} from "@/stores/use-config-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const updateConfig = useConfigStore((state) => state.updateConfig);

    usePromptSourceScheduler();

    // Automatically check and resume pending image generations on app initialization
    useEffect(() => {
        void useImageWorkbenchStore.getState().resumePendingLogs({
            onSuccessMessage: (msg) => message.success(msg),
            onErrorMessage: (msg) => message.error(msg),
        });
    }, [message]);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        const channelName = searchParams.get("channelName") || searchParams.get("channelname");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        searchParams.delete("channelName");
        searchParams.delete("channelname");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);

        const result = importChannelCredentials({ baseUrl, apiKey });
        openConfigDialog(false, "channels");
        if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
        else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
        else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
        else message.error(t("config.importedChannelBaseUrlInvalid"));

        // Background sync models if credentials are valid
        if (baseUrl && apiKey && (result.status === "created" || result.status === "updated")) {
            const currentChannels = useConfigStore.getState().config.channels || [];
            const targetChannel = currentChannels.find((ch) => ch.baseUrl === baseUrl) || currentChannels[0];
            if (targetChannel) {
                void (async () => {
                    try {
                        const fetchedNames = await fetchChannelModels(targetChannel);
                        if (fetchedNames && fetchedNames.length > 0) {
                            const newModels = normalizeChannelModels(
                                fetchedNames.map((name) => ({
                                    name,
                                    capability: guessCapability(name),
                                })),
                            );
                            const autoFormat = guessApiFormat(newModels, targetChannel.baseUrl);
                            const updatedChannel = { ...targetChannel, models: newModels, apiFormat: autoFormat };
                            const nextChannels = currentChannels.map((ch) => (ch.id === targetChannel.id ? updatedChannel : ch));
                            const allModels = modelOptionsFromChannels(nextChannels);
                            const nextConfig: AiConfig = {
                                ...useConfigStore.getState().config,
                                channels: nextChannels,
                                models: allModels,
                            };

                            const pickModel = (cap: ModelCapability, cur: string) => {
                                const opts = selectableModelsByCapability(nextConfig, cap);
                                const norm = normalizeModelOptionValue(cur, nextChannels);
                                return opts.includes(norm) ? norm : opts[0] || cur || allModels[0] || "";
                            };

                            nextConfig.imageModel = pickModel("image", nextConfig.imageModel);
                            nextConfig.videoModel = pickModel("video", nextConfig.videoModel);
                            nextConfig.textModel = pickModel("text", nextConfig.textModel);
                            nextConfig.audioModel = pickModel("audio", nextConfig.audioModel);

                            (Object.keys(nextConfig) as Array<keyof AiConfig>).forEach((key) => {
                                updateConfig(key, nextConfig[key]);
                            });
                            message.success(`已自动就绪 ${newModels.length} 个可用模型`);
                        }
                    } catch {
                        // ignore background fetch error
                    }
                })();
            }
        }
    }, [importChannelCredentials, message, openConfigDialog, t, updateConfig]);

    return <>{children}</>;
}
