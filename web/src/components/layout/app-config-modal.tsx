"use client";

import { App, Button, Form, Input, Modal, Progress, Segmented, Select, Tabs } from "antd";
import { CircleAlert, Cloud, Plus, RefreshCw, Trash2, Wifi } from "lucide-react";
import { useState } from "react";

import { ModelPicker } from "@/components/model-picker";
import { fetchChannelEndpointModels } from "@/services/api/image";
import { syncAppDataToWebdav, type AppSyncDomainKey, type AppSyncProgressEvent } from "@/services/app-sync";
import { testWebdavConnection, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { applyServerConfig, SERVER_API_KEY_PLACEHOLDER, type ServerConfig } from "@/lib/server-config-client";
import { channelModels, createModelChannel, createModelEndpoint, defaultBaseUrlForApiFormat, filterModelsByCapability, modelEndpointKeys, modelOptionLabel, modelOptionName, modelOptionsFromChannels, normalizeModelOptionValue, useConfigStore, type AiConfig, type ApiCallFormat, type ModelCapability, type ModelChannel, type ModelEndpointConfig, type ModelEndpointKey } from "@/stores/use-config-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    modelsKey: "imageModels" | "videoModels" | "textModels" | "audioModels";
    defaultLabel: string;
    optionsLabel: string;
};

type EndpointGroup = {
    key: ModelEndpointKey;
    label: string;
    hint: string;
    placeholder: string;
};

type WebdavDomainProgress = {
    label: string;
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", modelsKey: "imageModels", defaultLabel: "默认生图模型", optionsLabel: "生图模型可选项" },
    { capability: "video", modelKey: "videoModel", modelsKey: "videoModels", defaultLabel: "默认视频模型", optionsLabel: "视频模型可选项" },
    { capability: "text", modelKey: "textModel", modelsKey: "textModels", defaultLabel: "默认文本模型", optionsLabel: "文本模型可选项" },
    { capability: "audio", modelKey: "audioModel", modelsKey: "audioModels", defaultLabel: "默认音频模型", optionsLabel: "音频模型可选项" },
];

const endpointGroups: EndpointGroup[] = [
    { key: "image", label: "图片", hint: "生图、图片编辑和画布标注编辑", placeholder: "例如 gpt-image-2、seedream" },
    { key: "text", label: "文本", hint: "画布助手、提示词优化和文本生成", placeholder: "例如 gpt-4o-mini、gpt-5.5" },
    { key: "video", label: "视频", hint: "视频生成和视频任务查询", placeholder: "例如 grok-imagine-video、seedance" },
];

const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
    { label: "OpenAI", value: "openai" },
    { label: "Gemini", value: "gemini" },
];

const webdavDomainKeys: AppSyncDomainKey[] = ["canvas", "assets", "image-workbench", "video-workbench"];
const webdavDomainLabels: Record<AppSyncDomainKey, string> = {
    canvas: "画布",
    assets: "我的素材",
    "image-workbench": "生图工作台",
    "video-workbench": "视频创作台",
};

function createWebdavDomainProgress(): Record<AppSyncDomainKey, WebdavDomainProgress> {
    return webdavDomainKeys.reduce(
        (progress, key) => ({
            ...progress,
            [key]: { label: webdavDomainLabels[key], stage: "等待同步" },
        }),
        {} as Record<AppSyncDomainKey, WebdavDomainProgress>,
    );
}

export function AppConfigModal() {
    const { message } = App.useApp();
    const [activeTab, setActiveTab] = useState("channels");
    const [loadingChannelId, setLoadingChannelId] = useState("");
    const [savingServerConfig, setSavingServerConfig] = useState(false);
    const [testingWebdav, setTestingWebdav] = useState(false);
    const [syncingWebdav, setSyncingWebdav] = useState(false);
    const [webdavSyncStatus, setWebdavSyncStatus] = useState("");
    const [webdavDomainProgress, setWebdavDomainProgress] = useState(createWebdavDomainProgress);
    const config = useConfigStore((state) => state.config);
    const webdav = useConfigStore((state) => state.webdav);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const modelOptions = config.models.map((model) => ({ label: modelOptionLabel(config, model), value: model }));
    const webdavReady = Boolean(webdav.url.trim());

    const saveConfig = (nextConfig: AiConfig) => {
        (Object.keys(nextConfig) as Array<keyof AiConfig>).forEach((key) => updateConfig(key, nextConfig[key]));
    };

    const finishConfig = async () => {
        const ready = config.channels.some(channelHasPersistableEndpoint);
        if (!ready) {
            setConfigDialogOpen(false);
            return;
        }
        const serverChannel = config.channels.find(isPersistableServerChannel);
        if (serverChannel) {
            setSavingServerConfig(true);
            try {
                const serverConfig = await saveServerConfig(config, serverChannel);
                applyServerConfig(updateConfig, serverConfig);
                setConfigDialogOpen(false);
                message.success(shouldPromptContinue ? "已保存到服务器，请继续刚才的请求" : "已保存到服务器");
                clearPromptContinue();
            } catch (error) {
                message.error(error instanceof Error ? error.message : "保存服务器配置失败");
            } finally {
                setSavingServerConfig(false);
            }
            return;
        }
        setConfigDialogOpen(false);
        message.success(shouldPromptContinue ? "配置已保存，请继续刚才的请求" : "配置已保存");
        clearPromptContinue();
    };

    const updateChannels = (channels: ModelChannel[]) => {
        const nextConfig = withChannels(config, channels);
        saveConfig(nextConfig);
    };

    const updateChannel = (id: string, patch: Partial<ModelChannel>) => {
        updateChannels(config.channels.map((channel) => (channel.id === id ? syncChannelModels({ ...channel, ...patch }) : channel)));
    };

    const updateChannelEndpoint = (channel: ModelChannel, key: ModelEndpointKey, patch: Partial<ModelEndpointConfig>) => {
        const currentEndpoint = channel.endpoints[key];
        const endpoint = createModelEndpoint({ ...currentEndpoint, ...patch }, { baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat, models: channel.models }, key);
        const nextEndpoint = patch.models ? { ...endpoint, models: uniqueModels(patch.models.map(modelOptionName)) } : endpoint;
        const endpoints = { ...channel.endpoints, [key]: nextEndpoint };
        updateChannel(channel.id, { endpoints });
    };

    const updateEndpointApiFormat = (channel: ModelChannel, key: ModelEndpointKey, apiFormat: ApiCallFormat) => {
        const endpoint = channel.endpoints[key];
        const baseUrl = !endpoint.baseUrl.trim() || endpoint.baseUrl.trim() === defaultBaseUrlForApiFormat(endpoint.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : endpoint.baseUrl;
        updateChannelEndpoint(channel, key, { apiFormat, baseUrl });
    };

    const addChannel = () => {
        updateChannels([...config.channels, createModelChannel({ name: `渠道 ${config.channels.length + 1}` })]);
    };

    const deleteChannel = (id: string) => {
        if (config.channels.length <= 1) {
            message.warning("至少保留一个渠道");
            return;
        }
        updateChannels(config.channels.filter((channel) => channel.id !== id));
    };

    const refreshChannelEndpointModels = async (channel: ModelChannel, key: ModelEndpointKey) => {
        const endpoint = channel.endpoints[key];
        if (!endpoint.baseUrl.trim() || !endpoint.apiKey.trim()) {
            message.error(`请先填写${endpointLabel(key)}端点的 Base URL 和 API Key`);
            return;
        }
        setLoadingChannelId(`${channel.id}:${key}`);
        try {
            const models = await fetchChannelEndpointModels(endpoint);
            updateChannelEndpoint(channel, key, { models });
            message.success(`${channel.name} ${endpointLabel(key)}模型列表已更新`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingChannelId("");
        }
    };

    const refreshAllModels = async () => {
        const runnable = config.channels.flatMap((channel) =>
            modelEndpointKeys
                .map((key) => ({ channel, key, endpoint: channel.endpoints[key] }))
                .filter(({ endpoint }) => endpoint.baseUrl.trim() && endpoint.apiKey.trim()),
        );
        if (!runnable.length) {
            message.error("请先填写至少一个渠道的 Base URL 和 API Key");
            return;
        }
        setLoadingChannelId("all");
        try {
            const entries = await Promise.all(runnable.map(async ({ channel, key, endpoint }) => [`${channel.id}:${key}`, await fetchChannelEndpointModels(endpoint)] as const));
            const modelMap = new Map(entries);
            updateChannels(
                config.channels.map((channel) => {
                    const endpoints = { ...channel.endpoints };
                    modelEndpointKeys.forEach((key) => {
                        const models = modelMap.get(`${channel.id}:${key}`);
                        if (models) endpoints[key] = { ...endpoints[key], models };
                    });
                    return syncChannelModels({ ...channel, endpoints });
                }),
            );
            message.success("模型列表已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setLoadingChannelId("");
        }
    };

    const updateCapabilityModels = (group: ModelGroup, models: string[]) => {
        const next = uniqueModels(models.map((model) => normalizeModelOptionValue(model, config.channels)).filter(Boolean));
        updateConfig(group.modelsKey, next);
        if (!next.includes(config[group.modelKey])) updateConfig(group.modelKey, next[0] || "");
    };

    const testWebdav = async () => {
        if (!webdavReady) {
            message.error("请先填写 WebDAV 地址");
            return;
        }
        setTestingWebdav(true);
        try {
            await testWebdavConnection(webdav);
            message.success("WebDAV 连接可用");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "WebDAV 连接测试失败");
        } finally {
            setTestingWebdav(false);
        }
    };

    const updateWebdavProgress = (event: AppSyncProgressEvent) => {
        setWebdavSyncStatus(event.stage);
        if (!event.domain) return;
        setWebdavDomainProgress((current) => ({
            ...current,
            [event.domain as AppSyncDomainKey]: {
                label: event.label || webdavDomainLabels[event.domain as AppSyncDomainKey],
                stage: event.stage,
                current: event.current,
                total: event.total,
                status: event.status,
            },
        }));
    };

    const syncWebdav = async () => {
        if (!webdavReady) {
            message.error("请先填写 WebDAV 地址");
            return;
        }
        setSyncingWebdav(true);
        setWebdavDomainProgress(createWebdavDomainProgress());
        setWebdavSyncStatus("准备同步");
        try {
            const result = await syncAppDataToWebdav(webdav, updateWebdavProgress);
            updateWebdavConfig("lastSyncedAt", result.syncedAt);
            message.success(`同步完成：${result.projects} 个画布，${result.assets} 个素材，${result.imageLogs + result.videoLogs} 条记录，本次上传 ${result.uploadedFiles} 个文件 ${formatBytes(result.uploadedBytes)}`);
        } catch (error) {
            setWebdavSyncStatus(error instanceof Error ? error.message : "WebDAV 同步失败");
            message.error(error instanceof Error ? error.message : "WebDAV 同步失败");
        } finally {
            setSyncingWebdav(false);
        }
    };

    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">配置与用户偏好</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">渠道聚合、模型选择和同步偏好</div>
                </div>
            }
            open={isConfigOpen}
            width={980}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }}
            footer={
                <Button type="primary" loading={savingServerConfig} onClick={() => void finishConfig()}>
                    保存
                </Button>
            }
        >
            <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                    {
                        key: "channels",
                        label: "渠道",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex w-fit max-w-full flex-wrap items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
                                            <CircleAlert className="size-3.5 shrink-0" />
                                            <span className="font-semibold">重要：</span>
                                            <span>填写 URL 和 Key 后点保存，会自动存到服务器并启用服务器代理。</span>
                                            <Button type="link" size="small" className="h-auto p-0 text-xs font-semibold text-amber-900 dark:text-amber-100" onClick={() => setActiveTab("models")}>
                                                去模型设置
                                            </Button>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 gap-2">
                                        <Button icon={<RefreshCw className="size-4" />} loading={Boolean(loadingChannelId)} onClick={() => void refreshAllModels()}>
                                            拉取全部
                                        </Button>
                                        <Button type="primary" icon={<Plus className="size-4" />} onClick={addChannel}>
                                            新增渠道
                                        </Button>
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    {config.channels.map((channel) => (
                                        <section key={channel.id} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                            <div className="mb-3 flex items-center justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="truncate text-sm font-semibold">{channel.name || "未命名渠道"}</div>
                                                    <div className="mt-1 text-xs text-stone-500">{endpointSummary(channel)} · 共 {channelModels(channel).length} 个模型</div>
                                                </div>
                                                <div className="flex shrink-0 gap-2">
                                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => deleteChannel(channel.id)} />
                                                </div>
                                            </div>
                                            <div className="mb-3 grid gap-4 md:grid-cols-2">
                                                <Form.Item label="渠道名称" className="mb-0">
                                                    <Input value={channel.name} onChange={(event) => updateChannel(channel.id, { name: event.target.value })} />
                                                </Form.Item>
                                                <Form.Item label="默认调用格式" className="mb-0">
                                                    <Select value={channel.apiFormat} options={apiFormatOptions} onChange={(value: ApiCallFormat) => updateChannel(channel.id, { apiFormat: value, baseUrl: defaultBaseUrlForApiFormat(value) })} />
                                                </Form.Item>
                                            </div>
                                            <div className="space-y-4">
                                                {endpointGroups.map((group) => {
                                                    const endpoint = channel.endpoints[group.key];
                                                    const loadingKey = `${channel.id}:${group.key}`;
                                                    return (
                                                        <div key={group.key} className="border-t border-stone-200 pt-4 first:border-t-0 first:pt-0 dark:border-stone-800">
                                                            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                                                <div>
                                                                    <div className="text-sm font-medium">{group.label}模型地址</div>
                                                                    <div className="mt-0.5 text-xs text-stone-500">{group.hint}</div>
                                                                </div>
                                                                <Button size="small" loading={loadingChannelId === loadingKey} onClick={() => void refreshChannelEndpointModels(channel, group.key)}>
                                                                    拉取{group.label}模型
                                                                </Button>
                                                            </div>
                                                            <div className="grid gap-4 md:grid-cols-2">
                                                                <Form.Item label="调用格式" className="mb-0">
                                                                    <Select value={endpoint.apiFormat} options={apiFormatOptions} onChange={(value: ApiCallFormat) => updateEndpointApiFormat(channel, group.key, value)} />
                                                                </Form.Item>
                                                                <Form.Item label="Base URL" className="mb-0">
                                                                    <Input value={endpoint.baseUrl} onChange={(event) => updateChannelEndpoint(channel, group.key, { baseUrl: event.target.value })} />
                                                                </Form.Item>
                                                                <Form.Item label="API Key" className="mb-0 md:col-span-2">
                                                                    <Input.Password value={endpoint.apiKey} onChange={(event) => updateChannelEndpoint(channel, group.key, { apiKey: event.target.value })} />
                                                                </Form.Item>
                                                                <Form.Item label={`${group.label}模型列表`} className="mb-0 md:col-span-2">
                                                                    <Select
                                                                        mode="tags"
                                                                        showSearch
                                                                        allowClear
                                                                        maxTagCount="responsive"
                                                                        placeholder={group.placeholder}
                                                                        value={endpoint.models}
                                                                        onChange={(models) => updateChannelEndpoint(channel, group.key, { models })}
                                                                    />
                                                                </Form.Item>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    ))}
                                </div>
                            </Form>
                        ),
                    },
                    {
                        key: "models",
                        label: "模型",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="text-sm font-semibold">默认模型和可选项</div>
                                    <div className="mt-1 text-xs leading-5 text-stone-500">可选项决定各处下拉框展示哪些模型；同名模型会以括号里的渠道名区分。</div>
                                </div>
                                <div className="grid gap-4 md:grid-cols-2">
                                    {modelGroups.map((group) => (
                                        <Form.Item key={group.modelsKey} label={group.optionsLabel} className="mb-0">
                                            <Select
                                                mode="tags"
                                                showSearch
                                                allowClear
                                                maxTagCount="responsive"
                                                placeholder={config.models.length ? `请选择或输入${group.optionsLabel}` : "先到渠道里填写或拉取模型"}
                                                value={config[group.modelsKey]}
                                                options={modelOptions}
                                                onChange={(models) => updateCapabilityModels(group, models)}
                                            />
                                        </Form.Item>
                                    ))}
                                </div>
                                <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                    {modelGroups.map((group) => (
                                        <Form.Item key={group.modelKey} label={group.defaultLabel} className="mb-0">
                                            <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                        </Form.Item>
                                    ))}
                                </div>
                            </Form>
                        ),
                    },
                    {
                        key: "preferences",
                        label: "生成偏好",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="grid gap-4 md:grid-cols-4">
                                    <Form.Item label="画布默认生图张数" extra="新建画布生图和配置节点默认使用，单个节点仍可单独覆盖。" className="mb-4">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.canvasImageCount}
                                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                        />
                                    </Form.Item>
                                    <Form.Item label="默认音频声音" className="mb-4">
                                        <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
                                    </Form.Item>
                                    <Form.Item label="默认音频格式" className="mb-4">
                                        <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                                    </Form.Item>
                                    <Form.Item label="默认音频语速" className="mb-4">
                                        <Input
                                            type="number"
                                            min={0.25}
                                            max={4}
                                            step={0.05}
                                            value={config.audioSpeed}
                                            onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                                            onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                        />
                                    </Form.Item>
                                </div>
                                <Form.Item label="默认音频指令" className="mb-4">
                                    <Input.TextArea rows={2} value={config.audioInstructions} placeholder="例如：自然、温暖、适合旁白。" onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                                </Form.Item>
                                <Form.Item label="系统提示词" className="mb-0">
                                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder="例如：你是一位擅长电影感写实摄影的视觉导演。" onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                                </Form.Item>
                            </Form>
                        ),
                    },
                    {
                        key: "webdav",
                        label: "WebDAV",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <div className="flex items-center gap-2 text-sm font-semibold">
                                                <Cloud className="size-4" />
                                                WebDAV 同步
                                            </div>
                                            <div className="mt-1 text-xs text-stone-500">同步画布、我的素材、生成记录和本地媒体文件，不包含 AI API Key；服务不支持 CORS 时可走 Next.js 转发。</div>
                                        </div>
                                        <div className="text-xs text-stone-500">{webdav.lastSyncedAt ? `上次同步 ${formatWebdavTime(webdav.lastSyncedAt)}` : "尚未同步"}</div>
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <Form.Item label="连接方式" className="mb-4 md:col-span-2">
                                            <Segmented
                                                block
                                                value={webdav.proxyMode}
                                                onChange={(value) => updateWebdavConfig("proxyMode", value as typeof webdav.proxyMode)}
                                                options={[
                                                    { label: "前端直连", value: "direct" },
                                                    { label: "Next.js 转发", value: "nextjs" },
                                                ]}
                                            />
                                        </Form.Item>
                                        <Form.Item label="WebDAV 地址" className="mb-4">
                                            <Input value={webdav.url} placeholder="https://nas.example.com/webdav" onChange={(event) => updateWebdavConfig("url", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="远程目录" extra={`会在该目录下分业务目录保存，每个目录包含 ${WEBDAV_MANIFEST_FILE_NAME} 和 files/`} className="mb-4">
                                            <Input value={webdav.directory} placeholder="infinite-canvas" onChange={(event) => updateWebdavConfig("directory", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="用户名" className="mb-0">
                                            <Input value={webdav.username} autoComplete="username" onChange={(event) => updateWebdavConfig("username", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label="密码 / 应用密码" className="mb-0">
                                            <Input.Password value={webdav.password} autoComplete="current-password" onChange={(event) => updateWebdavConfig("password", event.target.value)} />
                                        </Form.Item>
                                    </div>
                                    <div className="mt-4 flex flex-wrap items-center gap-2">
                                        <Button icon={<Wifi className="size-4" />} disabled={!webdavReady || syncingWebdav} loading={testingWebdav} onClick={() => void testWebdav()}>
                                            测试连接
                                        </Button>
                                        <Button type="primary" icon={<RefreshCw className="size-4" />} disabled={!webdavReady || testingWebdav} loading={syncingWebdav} onClick={() => void syncWebdav()}>
                                            {syncingWebdav ? "同步中" : "立即同步"}
                                        </Button>
                                        {webdavSyncStatus ? <span className="text-xs text-stone-500">{webdavSyncStatus}</span> : null}
                                    </div>
                                    {syncingWebdav || webdavSyncStatus ? <WebdavProgressGrid progress={webdavDomainProgress} /> : null}
                                </section>
                            </Form>
                        ),
                    },
                ]}
            />
        </Modal>
    );
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const normalizedChannels = channels.map(syncChannelModels);
    const models = modelOptionsFromChannels(normalizedChannels);
    const imageModels = mergeOrSuggest(config.imageModels, filterModelsByCapability(models, "image"), models);
    const videoModels = mergeOrSuggest(config.videoModels, filterModelsByCapability(models, "video"), models);
    const textModels = mergeOrSuggest(config.textModels, filterModelsByCapability(models, "text"), models);
    const audioModels = mergeOrSuggest(config.audioModels, filterModelsByCapability(models, "audio"), models);
    const firstEndpoint = firstConfiguredEndpoint(normalizedChannels[0]) || normalizedChannels[0]?.endpoints.image;
    return {
        ...config,
        channels: normalizedChannels,
        models,
        baseUrl: firstEndpoint?.baseUrl || config.baseUrl,
        apiKey: firstEndpoint?.apiKey || config.apiKey,
        apiFormat: firstEndpoint?.apiFormat || config.apiFormat,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        imageModel: normalizeDefaultModel(config.imageModel, imageModels),
        videoModel: normalizeDefaultModel(config.videoModel, videoModels),
        textModel: normalizeDefaultModel(config.textModel, textModels),
        audioModel: normalizeDefaultModel(config.audioModel, audioModels),
    };
}

function isPersistableServerChannel(channel: ModelChannel) {
    return channelHasPersistableEndpoint(channel);
}

function channelHasPersistableEndpoint(channel: ModelChannel) {
    return modelEndpointKeys.some((key) => isPersistableEndpoint(channel.endpoints[key]));
}

function isPersistableEndpoint(endpoint: ModelEndpointConfig) {
    const baseUrl = endpoint.baseUrl.trim();
    const apiKey = endpoint.apiKey.trim();
    return Boolean(baseUrl && apiKey && !baseUrl.startsWith("/api/ai") && apiKey !== SERVER_API_KEY_PLACEHOLDER);
}

function firstConfiguredEndpoint(channel?: ModelChannel) {
    if (!channel) return undefined;
    return modelEndpointKeys.map((key) => channel.endpoints[key]).find((endpoint) => endpoint.baseUrl.trim() && endpoint.apiKey.trim());
}

function syncChannelModels(channel: ModelChannel) {
    return { ...channel, models: uniqueModels(modelEndpointKeys.flatMap((key) => channel.endpoints[key]?.models || [])) };
}

async function saveServerConfig(config: AiConfig, channel: ModelChannel): Promise<ServerConfig> {
    const endpoints = Object.fromEntries(
        modelEndpointKeys.map((key) => {
            const endpoint = channel.endpoints[key];
            return [
                key,
                {
                    apiFormat: "openai",
                    baseUrl: endpoint.baseUrl,
                    apiKey: endpoint.apiKey,
                    models: endpoint.models.map(modelOptionName),
                },
            ];
        }),
    );
    const payload = {
        enabled: true,
        channelName: channel.name || "服务器渠道",
        apiFormat: "openai",
        baseUrl: firstConfiguredEndpoint(channel)?.baseUrl || channel.baseUrl,
        apiKey: firstConfiguredEndpoint(channel)?.apiKey || channel.apiKey,
        endpoints,
        models: channelModels(channel).map(modelOptionName),
        imageModels: config.imageModels.map(modelOptionName),
        videoModels: config.videoModels.map(modelOptionName),
        textModels: config.textModels.map(modelOptionName),
        audioModels: config.audioModels.map(modelOptionName),
        imageModel: modelOptionName(config.imageModel),
        videoModel: modelOptionName(config.videoModel),
        textModel: modelOptionName(config.textModel),
        audioModel: modelOptionName(config.audioModel),
    };
    const response = await fetch("/api/server-config", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || "保存服务器配置失败");
    return data as ServerConfig;
}

function endpointSummary(channel: ModelChannel) {
    return endpointGroups.map((group) => `${group.label} ${channel.endpoints[group.key].models.length}`).join(" · ");
}

function endpointLabel(key: ModelEndpointKey) {
    return endpointGroups.find((group) => group.key === key)?.label || key;
}

function mergeOrSuggest(current: string[], suggested: string[], allModels: string[]) {
    const available = new Set(allModels);
    const kept = uniqueModels(current).filter((model) => available.has(model));
    const merged = uniqueModels([...kept, ...suggested]);
    return merged.length ? merged : suggested;
}

function normalizeDefaultModel(value: string, options: string[]) {
    if (options.includes(value)) return value;
    return options[0] || value;
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function formatWebdavTime(value: string) {
    return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function WebdavProgressGrid({ progress }: { progress: Record<AppSyncDomainKey, WebdavDomainProgress> }) {
    return (
        <div className="mt-3 grid gap-2">
            {webdavDomainKeys.map((key) => {
                const item = progress[key];
                const count = item.total ? `${item.current || 0}/${item.total}` : "";
                return (
                    <div key={key} className="rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                        <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs">
                            <span className="shrink-0 font-medium text-stone-700 dark:text-stone-200">{item.label}</span>
                            <span className="min-w-0 truncate text-right text-stone-500">
                                {item.stage}
                                {count ? ` · ${count}` : ""}
                            </span>
                        </div>
                        <Progress percent={getWebdavProgressPercent(item)} size="small" status={getWebdavProgressStatus(item)} showInfo={false} />
                    </div>
                );
            })}
        </div>
    );
}

function getWebdavProgressPercent(item: WebdavDomainProgress) {
    if (item.status === "success") return 100;
    if (item.total) return Math.min(100, Math.round(((item.current || 0) / item.total) * 100));
    if (item.status === "exception") return 100;
    if (item.stage === "等待同步") return 0;
    if (item.stage === "读取远端清单") return 12;
    if (item.stage === "读取本地数据") return 24;
    if (item.stage === "下载缺失媒体") return 36;
    if (item.stage === "写入本地合并结果") return 58;
    if (item.stage === "上传新增媒体") return 66;
    if (item.stage === "媒体已齐全" || item.stage === "媒体无需上传") return 74;
    if (item.stage.startsWith("上传清单")) return 90;
    return item.status === "active" ? 30 : 0;
}

function getWebdavProgressStatus(item: WebdavDomainProgress): "normal" | "active" | "success" | "exception" {
    if (item.status === "success" || item.status === "exception") return item.status;
    return item.status === "active" ? "active" : "normal";
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
