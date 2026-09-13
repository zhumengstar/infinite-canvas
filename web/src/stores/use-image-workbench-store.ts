import { create } from "zustand";
import localforage from "localforage";
import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { deleteStoredImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { ensureTargetImageResolution, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";

export type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

export type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
};

export type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "pending" | "success" | "failed";
    images: GeneratedImage[];
    thumbnails: string[];
    error?: string;
};

export type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

export type ImageRequestSnapshot = {
    text: string;
    config: AiConfig;
    references: ReferenceImage[];
};

export const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

let elapsedTimer: number | null = null;

export async function readStoredLogs(): Promise<GenerationLog[]> {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await imageLogStore.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

export async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "success",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
        error: log.error,
    };
}

export function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
        thumbnails: [],
    };
}

export function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
}

export function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
    id,
    createdAt,
    error,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
    id?: string;
    createdAt?: number;
    error?: string;
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    const now = createdAt || Date.now();
    return {
        id: id || nanoid(),
        createdAt: now,
        title: prompt.slice(0, 16) || i18n.t("workbench.untitled"),
        prompt,
        time: new Date(now).toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount || 1,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
        error,
    };
}

type StartGenerationOptions = {
    prompt: string;
    references: ReferenceImage[];
    config: AiConfig;
    model: string;
    generationCount: number;
    existingLogId?: string;
    existingCreatedAt?: number;
    agentTaskId?: string;
    onSuccessMessage?: (msg: string) => void;
    onErrorMessage?: (msg: string) => void;
    updateAgentTask?: (id: string, patch: any) => void;
};

type ImageWorkbenchStore = {
    prompt: string;
    references: ReferenceImage[];
    results: GenerationResult[];
    logs: GenerationLog[];
    running: boolean;
    startedAt: number;
    elapsedMs: number;
    selectedLogIds: string[];
    previewLog: GenerationLog | null;
    activeLogId: string | null;

    setPrompt: (prompt: string) => void;
    setReferences: (references: ReferenceImage[] | ((prev: ReferenceImage[]) => ReferenceImage[])) => void;
    setResults: (results: GenerationResult[] | ((prev: GenerationResult[]) => GenerationResult[])) => void;
    setSelectedLogIds: (selectedLogIds: string[] | ((prev: string[]) => string[])) => void;
    setPreviewLog: (previewLog: GenerationLog | null) => void;
    setLogs: (logs: GenerationLog[]) => void;

    createSession: () => void;
    previewGenerationLog: (log: GenerationLog) => void;
    refreshLogs: () => Promise<GenerationLog[]>;
    saveLog: (log: GenerationLog) => Promise<void>;
    deleteSelectedLogs: () => Promise<void>;

    startGeneration: (options: StartGenerationOptions) => Promise<void>;
    retryResult: (index: number, snapshot: ImageRequestSnapshot) => Promise<void>;
    resumePendingLogs: (callbacks?: { onSuccessMessage?: (msg: string) => void; onErrorMessage?: (msg: string) => void }) => Promise<void>;
};

export const useImageWorkbenchStore = create<ImageWorkbenchStore>((set, get) => ({
    prompt: "",
    references: [],
    results: [],
    logs: [],
    running: false,
    startedAt: 0,
    elapsedMs: 0,
    selectedLogIds: [],
    previewLog: null,
    activeLogId: null,

    setPrompt: (prompt) => set({ prompt }),
    setReferences: (references) =>
        set((state) => ({ references: typeof references === "function" ? references(state.references) : references })),
    setResults: (results) =>
        set((state) => ({ results: typeof results === "function" ? results(state.results) : results })),
    setSelectedLogIds: (selectedLogIds) =>
        set((state) => ({ selectedLogIds: typeof selectedLogIds === "function" ? selectedLogIds(state.selectedLogIds) : selectedLogIds })),
    setPreviewLog: (previewLog) => set({ previewLog }),
    setLogs: (logs) => set({ logs }),

    createSession: () =>
        set({
            prompt: "",
            references: [],
            results: [],
            elapsedMs: 0,
            startedAt: 0,
            selectedLogIds: [],
            previewLog: null,
        }),

    previewGenerationLog: (log) => {
        const updateConfig = useConfigStore.getState().updateConfig;
        set({
            previewLog: log,
            prompt: log.prompt,
            references: log.references || [],
            results: log.images.map((image) => ({ id: image.id, status: "success", image })),
        });
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
    },

    refreshLogs: async () => {
        const loaded = await readStoredLogs();
        set((state) => {
            // If current results are empty and there are stored logs, auto-preview the latest log so results panel isn't blank
            if (!state.results.length && !state.running && loaded.length > 0 && !state.previewLog) {
                const first = loaded[0];
                return {
                    logs: loaded,
                    previewLog: first,
                    prompt: state.prompt || first.prompt,
                    references: state.references.length ? state.references : first.references || [],
                    results: first.images.map((image) => ({ id: image.id, status: "success", image })),
                };
            }
            return { logs: loaded };
        });
        return loaded;
    },

    saveLog: async (log) => {
        await imageLogStore.setItem(log.id, serializeLog(log));
        await get().refreshLogs();
    },

    deleteSelectedLogs: async () => {
        const { logs, selectedLogIds, previewLog } = get();
        const imageKeys = logs
            .filter((log) => selectedLogIds.includes(log.id))
            .flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        await Promise.all([deleteStoredImages(imageKeys), ...selectedLogIds.map((id) => imageLogStore.removeItem(id))]);
        const shouldClearResults = previewLog && selectedLogIds.includes(previewLog.id);
        set({
            selectedLogIds: [],
            previewLog: shouldClearResults ? null : previewLog,
            results: shouldClearResults ? [] : get().results,
        });
        await get().refreshLogs();
    },

    startGeneration: async ({
        prompt,
        references,
        config,
        model,
        generationCount,
        existingLogId,
        existingCreatedAt,
        agentTaskId,
        onSuccessMessage,
        onErrorMessage,
        updateAgentTask,
    }) => {
        const text = prompt.trim();
        if (!text) return;

        const logId = existingLogId || nanoid();
        const createdAt = existingCreatedAt || Date.now();
        const batchStartedAt = performance.now();

        // 1. Create and immediately persist pending log into IndexedDB
        const pendingLog = buildLog({
            id: logId,
            createdAt,
            prompt: text,
            model,
            config: { ...config, count: String(generationCount) },
            references: [...references],
            durationMs: 0,
            successCount: 0,
            failCount: 0,
            status: "pending",
            images: [],
        });

        await imageLogStore.setItem(logId, serializeLog(pendingLog));
        const currentLogs = await readStoredLogs();

        // 2. Setup global generation state
        set({
            running: true,
            startedAt: batchStartedAt,
            elapsedMs: 0,
            activeLogId: logId,
            previewLog: null,
            results: Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" })),
            logs: currentLogs,
        });

        if (agentTaskId && updateAgentTask) {
            updateAgentTask(agentTaskId, { status: "running", error: undefined });
        }

        // Start global timer
        if (elapsedTimer) clearInterval(elapsedTimer);
        elapsedTimer = window.setInterval(() => {
            const { running, startedAt } = get();
            if (!running || !startedAt) {
                if (elapsedTimer) {
                    clearInterval(elapsedTimer);
                    elapsedTimer = null;
                }
                return;
            }
            set({ elapsedMs: performance.now() - startedAt });
        }, 1000);

        const snapshot: ImageRequestSnapshot = {
            text,
            config: { ...config, model, count: "1" },
            references: [...references],
        };

        // 3. Concurrently run generation slots in the background
        const tasks = Array.from({ length: generationCount }, async (_, index) => {
            const itemStartedAt = performance.now();
            try {
                const result = snapshot.references.length
                    ? await requestEdit(snapshot.config, snapshot.text, snapshot.references)
                    : await requestGeneration(snapshot.config, snapshot.text);
                const image = result[0];
                if (!image) throw new Error(i18n.t("imageWorkbench.missingResult"));
                const targetSize = snapshot.config.size || (snapshot.config.quality === "high" ? "3840x2160" : undefined);
                const ensured = await ensureTargetImageResolution(image.dataUrl, targetSize);
                const nextImage: GeneratedImage = {
                    id: image.id,
                    dataUrl: ensured.dataUrl,
                    durationMs: performance.now() - itemStartedAt,
                    width: ensured.width,
                    height: ensured.height,
                    bytes: ensured.bytes,
                };
                set((state) => ({
                    results: state.results.map((r, i) => (i === index ? { id: r.id, status: "success", image: nextImage } : r)),
                }));
                return nextImage;
            } catch (error) {
                const errText = error instanceof Error ? error.message : i18n.t("workbench.generationFailed");
                set((state) => ({
                    results: state.results.map((r, i) => (i === index ? { id: r.id, status: "failed", error: errText } : r)),
                }));
                throw error;
            }
        });

        const settled = await Promise.allSettled(tasks);
        const successImages = settled.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map((item) => item.value);
        const successCount = successImages.length;
        const failCount = generationCount - successCount;
        const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
        const errorMsg = failed?.reason instanceof Error ? failed.reason.message : failCount ? i18n.t("workbench.generationFailed") : undefined;

        if (agentTaskId && updateAgentTask) {
            updateAgentTask(agentTaskId, {
                status: successCount ? "succeeded" : "failed",
                successCount,
                failCount,
                error: successCount ? undefined : errorMsg,
            });
        }

        try {
            // Store successful images
            const logImages = await Promise.all(
                successImages.map(async (img) => {
                    const stored = await uploadImage(img.dataUrl);
                    return {
                        ...img,
                        dataUrl: stored.url,
                        storageKey: stored.storageKey,
                        width: stored.width,
                        height: stored.height,
                        bytes: stored.bytes,
                        mimeType: stored.mimeType,
                    };
                }),
            );

            const durationMs = performance.now() - batchStartedAt;
            const finalLog = buildLog({
                id: logId,
                createdAt,
                prompt: text,
                model,
                config: { ...config, count: String(generationCount) },
                references: snapshot.references,
                durationMs,
                successCount,
                failCount,
                status: successCount > 0 ? "success" : "failed",
                images: logImages,
                error: successCount > 0 ? undefined : errorMsg,
            });

            await imageLogStore.setItem(logId, serializeLog(finalLog));
            const updatedLogs = await readStoredLogs();

            if (elapsedTimer) {
                clearInterval(elapsedTimer);
                elapsedTimer = null;
            }

            set({
                running: false,
                logs: updatedLogs,
                activeLogId: null,
                previewLog: finalLog,
            });

            if (successCount > 0) {
                onSuccessMessage?.(i18n.t("imageWorkbench.generated"));
                if (typeof window !== "undefined" && window.parent && window.parent !== window) {
                    try {
                        window.parent.postMessage(
                            {
                                type: "CANVAS_GENERATION_COMPLETED",
                                successCount,
                                prompt: text.slice(0, 30),
                            },
                            "*"
                        );
                    } catch {
                        /* ignore postMessage error */
                    }
                }
            } else {
                onErrorMessage?.(errorMsg || i18n.t("workbench.generationFailed"));
            }
        } catch (e) {
            if (elapsedTimer) {
                clearInterval(elapsedTimer);
                elapsedTimer = null;
            }
            set({ running: false, activeLogId: null });
        }
    },

    retryResult: async (index, snapshot) => {
        const { results, model } = get();
        set({
            previewLog: null,
            results: results.map((r, i) => (i === index ? { id: r.id, status: "pending", error: undefined, image: undefined } : r)),
        });
        const retryStartedAt = performance.now();
        try {
            const result = snapshot.references.length
                ? await requestEdit(snapshot.config, snapshot.text, snapshot.references)
                : await requestGeneration(snapshot.config, snapshot.text);
            const image = result[0];
            if (!image) throw new Error(i18n.t("imageWorkbench.missingResult"));
            const targetSize = snapshot.config.size || (snapshot.config.quality === "high" ? "3840x2160" : undefined);
            const ensured = await ensureTargetImageResolution(image.dataUrl, targetSize);
            const stored = await uploadImage(ensured.dataUrl);
            const nextImage: GeneratedImage = {
                id: image.id,
                dataUrl: stored.url,
                storageKey: stored.storageKey,
                durationMs: performance.now() - retryStartedAt,
                width: ensured.width || stored.width,
                height: ensured.height || stored.height,
                bytes: stored.bytes || ensured.bytes,
                mimeType: stored.mimeType,
            };
            set((state) => ({
                results: state.results.map((r, i) => (i === index ? { id: r.id, status: "success", image: nextImage } : r)),
            }));
            const singleLog = buildLog({
                prompt: snapshot.text,
                model,
                config: { ...snapshot.config, count: "1" },
                references: snapshot.references,
                durationMs: performance.now() - retryStartedAt,
                successCount: 1,
                failCount: 0,
                status: "success",
                images: [nextImage],
            });
            await imageLogStore.setItem(singleLog.id, serializeLog(singleLog));
            await get().refreshLogs();
        } catch (err) {
            const errText = err instanceof Error ? err.message : i18n.t("workbench.generationFailed");
            set((state) => ({
                results: state.results.map((r, i) => (i === index ? { id: r.id, status: "failed", error: errText } : r)),
            }));
        }
    },

    resumePendingLogs: async ({ onSuccessMessage, onErrorMessage } = {}) => {
        const stored = await readStoredLogs();
        const pending = stored.filter((l) => l.status === "pending");
        if (!pending.length) return;

        for (const log of pending) {
            const ageMs = Date.now() - log.createdAt;
            // If created within the last 5 minutes, automatically resume in the background!
            if (ageMs < 5 * 60 * 1000 && !get().running) {
                const count = Math.max(1, Math.min(10, Number(log.config.count) || log.imageCount || 1));
                void get().startGeneration({
                    prompt: log.prompt,
                    references: log.references || [],
                    config: { ...useConfigStore.getState().config, ...log.config },
                    model: log.model,
                    generationCount: count,
                    existingLogId: log.id,
                    existingCreatedAt: log.createdAt,
                    onSuccessMessage,
                    onErrorMessage,
                });
                break;
            } else if (ageMs >= 5 * 60 * 1000) {
                // Too old, mark as failed due to exit/interruption
                const failedLog: GenerationLog = {
                    ...log,
                    status: "failed",
                    error: "页面关闭导致生成中断，点击可重新生成",
                };
                await imageLogStore.setItem(log.id, serializeLog(failedLog));
            }
        }
        await get().refreshLogs();
    },
}));

// BeforeUnload listener to warn the user if a generation is actively running
if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", (event) => {
        if (useImageWorkbenchStore.getState().running) {
            event.preventDefault();
            event.returnValue = "正在后台生成图片，关闭可能会中断任务，确定退出吗？";
            return event.returnValue;
        }
    });
}
