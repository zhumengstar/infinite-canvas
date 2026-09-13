import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Cpu, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
    encodeChannelModel,
    guessCapability,
    modelOptionLabel,
    modelOptionName,
    modelOptionsFromChannels,
    normalizeChannelModels,
    selectableModelsByCapability,
    useConfigStore,
    type AiConfig,
    type ModelCapability,
} from "@/stores/use-config-store";
import { fetchChannelModels } from "@/services/api/image";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({
    config,
    value,
    onChange,
    capability,
    className,
    fullWidth = false,
    placeholder,
}: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const [fetching, setFetching] = useState(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);

    const activeChannel = useMemo(() => {
        if (!config.channels || config.channels.length === 0) return null;
        return config.channels[0];
    }, [config.channels]);

    // 静默自动拉取当前渠道的可用模型列表
    const fetchModels = useCallback(async () => {
        if (!activeChannel || !activeChannel.baseUrl || !activeChannel.apiKey) return;
        if (fetching) return;
        try {
            setFetching(true);
            const fetchedNames = await fetchChannelModels(activeChannel);
            if (fetchedNames && fetchedNames.length > 0) {
                const newModels = normalizeChannelModels(
                    fetchedNames.map((name) => ({
                        name,
                        capability: guessCapability(name),
                    })),
                );
                const updatedChannels = config.channels.map((ch, idx) =>
                    idx === 0 ? { ...ch, models: newModels } : ch,
                );
                const allModels = modelOptionsFromChannels(updatedChannels);
                updateConfig("channels", updatedChannels);
                updateConfig("models", allModels);
            }
        } catch (err) {
            console.warn("自动获取模型列表失败:", err);
        } finally {
            setFetching(false);
        }
    }, [activeChannel, config.channels, fetching, updateConfig]);

    const options = useMemo(() => {
        const set = new Set<string>();
        // 优先保证当前选中的值存在于候选中
        if (value) set.add(value);

        // 1. 匹配当前能力的模型
        const capabilityModels = selectableModelsByCapability(config, capability);
        capabilityModels.forEach((m) => {
            if (m) set.add(m);
        });

        // 2. 渠道内的所有模型作为备选补充
        if (config.channels && config.channels.length > 0) {
            config.channels.forEach((ch) => {
                ch.models.forEach((m) => {
                    const encoded = encodeChannelModel(ch.id, m.name);
                    if (encoded) set.add(encoded);
                });
            });
        }

        // 3. 全局 models
        (config.models || []).forEach((m) => {
            if (m) set.add(m);
        });

        return Array.from(set).filter((m): m is string => Boolean(m));
    }, [capability, config, value]);

    const current = value || "";
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    const handleOpenChange = useCallback(
        (nextOpen: boolean) => {
            if (nextOpen) {
                window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                // 当用户点击展开时，如果选项不足或尚未拉取，自动静默拉取
                if ((!options.length || (activeChannel && activeChannel.models.length === 0)) && activeChannel?.baseUrl) {
                    void fetchModels();
                }
            }
            // 绝不在此调用 onMissingConfig，防止弹出配置框
            setOpen(nextOpen);
        },
        [activeChannel, fetchModels, options.length, pickerId],
    );

    return (
        <Select open={open} value={current} onOpenChange={handleOpenChange} onValueChange={onChange}>
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={current ? modelOptionLabel(config, current) : pickerPlaceholder}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">
                    {current ? modelOptionLabel(config, current) : pickerPlaceholder}
                </span>
                {fetching && <LoaderCircle className="size-3 animate-spin text-muted-foreground shrink-0" />}
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl max-h-72 overflow-y-auto"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {fetching && !options.length ? (
                    <div className="flex items-center justify-center gap-2 p-3 text-xs text-muted-foreground">
                        <LoaderCircle className="size-4 animate-spin text-primary" />
                        <span>{t("workbench.fetchingModels", { defaultValue: "正在获取可用模型列表..." })}</span>
                    </div>
                ) : options.length ? (
                    options.map((model) => (
                        <SelectItem key={model} value={model} textValue={modelOptionLabel(config, model)}>
                            <ModelLabel config={config} model={model} />
                        </SelectItem>
                    ))
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {emptyModelLabel(config, capability)}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

function ModelLabel({ config, model }: { config: AiConfig; model: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="truncate">{modelOptionLabel(config, model)}</span>
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
