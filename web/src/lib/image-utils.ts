import i18n from "@/i18n";
import type { ReferenceImage } from "@/types/image";

export function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number) {
    const value = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(value / 60);
    const seconds = value % 60;
    return minutes ? i18n.t("common.durationMinutes", { minutes, seconds: String(seconds).padStart(2, "0") }) : i18n.t("common.durationSeconds", { seconds });
}

export function getDataUrlByteSize(dataUrl: string) {
    const base64 = dataUrl.split(",", 2)[1];
    if (!base64) {
        return 0;
    }
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(file);
    });
}

export function readImageMeta(dataUrl: string) {
    return new Promise<{ width: number; height: number; mimeType: string }>((resolve) => {
        const image = new Image();
        const done = () => resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 1024, mimeType: dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" });
        image.onload = done;
        image.onerror = done;
        setTimeout(done, 3000);
        image.src = dataUrl;
    });
}

export function dataUrlToFile(image: ReferenceImage) {
    const [header, content] = image.dataUrl.split(",", 2);
    const mimeType = header.match(/data:(.*?);base64/)?.[1] || image.type || "image/png";
    const binary = atob(content || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], image.name || "reference.png", { type: mimeType });
}

/**
 * Ensures an image meets or scales up to the requested target dimensions (e.g. 4K: 3840x2160).
 * Uses multi-step high-quality canvas resampling with smoothing to preserve sharpness and details.
 */
export async function ensureTargetImageResolution(
    dataUrl: string,
    targetSize?: string
): Promise<{ dataUrl: string; width: number; height: number; bytes: number }> {
    if (!dataUrl || !targetSize) {
        const meta = await readImageMeta(dataUrl);
        return { dataUrl, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(dataUrl) };
    }

    const match = targetSize.trim().match(/^(\d+)x(\d+)$/i);
    if (!match) {
        const meta = await readImageMeta(dataUrl);
        return { dataUrl, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(dataUrl) };
    }

    const targetWidth = Number(match[1]);
    const targetHeight = Number(match[2]);
    if (!targetWidth || !targetHeight || targetWidth <= 0 || targetHeight <= 0) {
        const meta = await readImageMeta(dataUrl);
        return { dataUrl, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(dataUrl) };
    }

    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            const curW = img.naturalWidth || 1024;
            const curH = img.naturalHeight || 1024;

            // If already at or exceeding target size, keep original
            if (curW >= targetWidth && curH >= targetHeight) {
                resolve({
                    dataUrl,
                    width: curW,
                    height: curH,
                    bytes: getDataUrlByteSize(dataUrl),
                });
                return;
            }

            const currentRatio = curW / curH;
            const targetRatio = targetWidth / targetHeight;

            let finalW = targetWidth;
            let finalH = targetHeight;

            // If aspect ratios differ significantly, fit keeping aspect ratio
            if (Math.abs(currentRatio - targetRatio) > 0.05) {
                if (currentRatio > targetRatio) {
                    finalW = targetWidth;
                    finalH = Math.round(targetWidth / currentRatio);
                } else {
                    finalH = targetHeight;
                    finalW = Math.round(targetHeight * currentRatio);
                }
            }

            let tempCanvas = document.createElement("canvas");
            let tempCtx = tempCanvas.getContext("2d");
            if (!tempCtx) {
                resolve({ dataUrl, width: curW, height: curH, bytes: getDataUrlByteSize(dataUrl) });
                return;
            }

            let stepW = curW;
            let stepH = curH;
            tempCanvas.width = stepW;
            tempCanvas.height = stepH;
            tempCtx.imageSmoothingEnabled = true;
            tempCtx.imageSmoothingQuality = "high";
            tempCtx.drawImage(img, 0, 0, stepW, stepH);

            // Progressive upscale
            while (stepW * 2 < finalW && stepH * 2 < finalH) {
                stepW *= 2;
                stepH *= 2;
                const nextCanvas = document.createElement("canvas");
                nextCanvas.width = stepW;
                nextCanvas.height = stepH;
                const nextCtx = nextCanvas.getContext("2d");
                if (nextCtx) {
                    nextCtx.imageSmoothingEnabled = true;
                    nextCtx.imageSmoothingQuality = "high";
                    nextCtx.drawImage(tempCanvas, 0, 0, stepW, stepH);
                    tempCanvas = nextCanvas;
                    tempCtx = nextCtx;
                } else {
                    break;
                }
            }

            const finalCanvas = document.createElement("canvas");
            finalCanvas.width = finalW;
            finalCanvas.height = finalH;
            const finalCtx = finalCanvas.getContext("2d");
            if (!finalCtx) {
                resolve({ dataUrl, width: curW, height: curH, bytes: getDataUrlByteSize(dataUrl) });
                return;
            }

            finalCtx.imageSmoothingEnabled = true;
            finalCtx.imageSmoothingQuality = "high";
            finalCtx.drawImage(tempCanvas, 0, 0, finalW, finalH);

            const isJpeg = dataUrl.startsWith("data:image/jpeg");
            const mimeType = isJpeg ? "image/jpeg" : "image/png";
            const upscaledDataUrl = finalCanvas.toDataURL(mimeType, 0.95);

            resolve({
                dataUrl: upscaledDataUrl,
                width: finalW,
                height: finalH,
                bytes: getDataUrlByteSize(upscaledDataUrl),
            });
        };
        img.onerror = () => {
            resolve({ dataUrl, width: 1024, height: 1024, bytes: getDataUrlByteSize(dataUrl) });
        };
        img.src = dataUrl;
    });
}
