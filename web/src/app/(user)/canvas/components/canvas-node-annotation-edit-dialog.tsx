"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Button, Input, Modal, Slider } from "antd";
import { ArrowUpRight, Brush, Circle, Eraser, RotateCcw, Type, WandSparkles, X } from "lucide-react";

import { readImageMeta } from "@/lib/image-utils";

export type CanvasImageAnnotationEditPayload = {
    prompt: string;
    annotatedDataUrl: string;
};

type AnnotationMode = "brush" | "circle" | "arrow" | "text" | "erase";

type Point = { x: number; y: number };

const defaultStrokeSize = 8;
const colors = ["#ef4444", "#f97316", "#facc15", "#22c55e", "#2563eb", "#a855f7", "#ffffff", "#111827"];

export function CanvasNodeAnnotationEditDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageAnnotationEditPayload) => void }) {
    const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<{ active: boolean; start: Point | null; last: Point | null }>({ active: false, start: null, last: null });
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [prompt, setPrompt] = useState("");
    const [text, setText] = useState("");
    const [mode, setMode] = useState<AnnotationMode>("circle");
    const [color, setColor] = useState(colors[0]);
    const [strokeSize, setStrokeSize] = useState(defaultStrokeSize);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) return;
        setPrompt("");
        setText("");
        setMode("circle");
        setColor(colors[0]);
        setStrokeSize(defaultStrokeSize);
        setError("");
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    useEffect(() => {
        clearCanvas(annotationCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
    }, [image]);

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        drawingRef.current = { active: true, start: point, last: point };
        if (mode === "text") {
            addText(point);
            drawingRef.current = { active: false, start: null, last: null };
            return;
        }
        if (mode === "brush" || mode === "erase") drawBrush(point, point);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active) return;
        event.preventDefault();
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const { start, last } = drawingRef.current;
        if (!start || !last) return;
        if (mode === "brush" || mode === "erase") {
            drawBrush(last, point);
            drawingRef.current.last = point;
            return;
        }
        renderShapePreview(start, point);
    };

    const stopDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!drawingRef.current.active) return;
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const start = drawingRef.current.start;
        if (start && mode !== "brush" && mode !== "erase" && mode !== "text") {
            drawShape(annotationCanvasRef.current, start, point, mode, color, strokeSize);
            clearCanvas(previewCanvasRef.current);
        }
        drawingRef.current = { active: false, start: null, last: null };
    };

    const drawBrush = (from: Point, to: Point) => {
        const canvas = annotationCanvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        context.save();
        context.lineCap = "round";
        context.lineJoin = "round";
        context.lineWidth = strokeSize;
        context.globalCompositeOperation = mode === "erase" ? "destination-out" : "source-over";
        context.strokeStyle = color;
        drawLine(context, from, to);
        context.restore();
        setError("");
    };

    const addText = (point: Point) => {
        const value = text.trim();
        if (!value) {
            setError("请输入要标注的文字");
            return;
        }
        const canvas = annotationCanvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        const fontSize = Math.max(18, strokeSize * 4);
        context.save();
        context.font = `700 ${fontSize}px sans-serif`;
        context.lineJoin = "round";
        context.strokeStyle = color === "#111827" ? "#ffffff" : "rgba(17, 24, 39, .82)";
        context.lineWidth = Math.max(4, strokeSize / 2);
        context.fillStyle = color;
        context.strokeText(value, point.x, point.y);
        context.fillText(value, point.x, point.y);
        context.restore();
        setError("");
    };

    const renderShapePreview = (from: Point, to: Point) => {
        clearCanvas(previewCanvasRef.current);
        drawShape(previewCanvasRef.current, from, to, mode, color, strokeSize);
    };

    const reset = () => {
        clearCanvas(annotationCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
        setError("");
    };

    const submit = async () => {
        const nextPrompt = prompt.trim();
        const canvas = annotationCanvasRef.current;
        if (!nextPrompt) return setError("请输入修改要求");
        if (!canvas) return;
        if (!canvasHasPaint(canvas)) return setError("请先添加圈选、箭头、画笔或文字标注");
        try {
            onConfirm({ prompt: nextPrompt, annotatedDataUrl: await buildAnnotatedImage(dataUrl, canvas) });
        } catch (error) {
            setError(error instanceof Error ? error.message : "生成标注图失败");
        }
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1040} centered destroyOnHidden>
            <div className="grid gap-5 lg:grid-cols-[minmax(380px,1fr)_320px]">
                <div className="flex min-h-[380px] items-center justify-center rounded-xl border border-black/10 bg-transparent dark:border-white/10">
                    <div className="relative inline-block max-w-full overflow-hidden rounded-lg bg-transparent select-none">
                        <img src={dataUrl} alt="" className="block max-h-[70vh] max-w-full bg-transparent" draggable={false} />
                        {image ? (
                            <>
                                <canvas ref={annotationCanvasRef} width={image.width} height={image.height} className="absolute inset-0 h-full w-full touch-none" />
                                <canvas
                                    ref={previewCanvasRef}
                                    width={image.width}
                                    height={image.height}
                                    className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                                    onPointerDown={startDraw}
                                    onPointerMove={moveDraw}
                                    onPointerUp={stopDraw}
                                    onPointerCancel={stopDraw}
                                />
                            </>
                        ) : null}
                    </div>
                </div>

                <div className="flex min-h-[380px] flex-col gap-5">
                    <div>
                        <h2 className="text-xl font-semibold">标注编辑</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : "读取中"}</div>
                    </div>

                    <div className="grid grid-cols-5 gap-2">
                        <ToolButton active={mode === "circle"} icon={<Circle className="size-4" />} label="圈" onClick={() => setMode("circle")} />
                        <ToolButton active={mode === "arrow"} icon={<ArrowUpRight className="size-4" />} label="箭头" onClick={() => setMode("arrow")} />
                        <ToolButton active={mode === "brush"} icon={<Brush className="size-4" />} label="画笔" onClick={() => setMode("brush")} />
                        <ToolButton active={mode === "text"} icon={<Type className="size-4" />} label="文字" onClick={() => setMode("text")} />
                        <ToolButton active={mode === "erase"} icon={<Eraser className="size-4" />} label="擦除" onClick={() => setMode("erase")} />
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {colors.map((item) => (
                            <button
                                key={item}
                                type="button"
                                className={`h-8 w-8 rounded-full border transition ${color === item ? "scale-110 border-black shadow-sm dark:border-white" : "border-black/10 dark:border-white/20"}`}
                                style={{ background: item }}
                                aria-label={`选择颜色 ${item}`}
                                onClick={() => setColor(item)}
                            />
                        ))}
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">线条粗细</span>
                            <span className="font-semibold">{strokeSize}px</span>
                        </div>
                        <Slider min={2} max={28} step={1} value={strokeSize} onChange={setStrokeSize} />
                    </div>

                    {mode === "text" ? <Input value={text} placeholder="输入标注文字后点击图片放置" onChange={(event) => setText(event.target.value)} /> : null}

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">修改要求</div>
                        <Input.TextArea
                            rows={5}
                            value={prompt}
                            status={error && !prompt.trim() ? "error" : undefined}
                            placeholder="例如：参考红圈和箭头，把标注位置替换成玻璃材质"
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                setError("");
                            }}
                        />
                        {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button icon={<RotateCcw className="size-4" />} onClick={reset}>
                            重置
                        </Button>
                        <div className="flex items-center gap-2">
                            <Button icon={<X className="size-4" />} onClick={onClose}>
                                取消
                            </Button>
                            <Button type="primary" icon={<WandSparkles className="size-4" />} onClick={() => void submit()}>
                                AI 修改
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function ToolButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
    return (
        <Button type={active ? "primary" : "default"} icon={icon} onClick={onClick}>
            {label}
        </Button>
    );
}

function readCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawShape(canvas: HTMLCanvasElement | null, from: Point, to: Point, mode: AnnotationMode, color: string, strokeSize: number) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = strokeSize;
    if (mode === "circle") drawCircle(context, from, to);
    if (mode === "arrow") drawArrow(context, from, to, strokeSize);
    context.restore();
}

function drawLine(context: CanvasRenderingContext2D, from: Point, to: Point) {
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
}

function drawCircle(context: CanvasRenderingContext2D, from: Point, to: Point) {
    const left = Math.min(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const width = Math.abs(from.x - to.x);
    const height = Math.abs(from.y - to.y);
    context.beginPath();
    context.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    context.stroke();
}

function drawArrow(context: CanvasRenderingContext2D, from: Point, to: Point, strokeSize: number) {
    drawLine(context, from, to);
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const length = Math.max(18, strokeSize * 4);
    context.beginPath();
    context.moveTo(to.x, to.y);
    context.lineTo(to.x - length * Math.cos(angle - Math.PI / 6), to.y - length * Math.sin(angle - Math.PI / 6));
    context.lineTo(to.x - length * Math.cos(angle + Math.PI / 6), to.y - length * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();
}

function canvasHasPaint(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) return true;
    }
    return false;
}

async function buildAnnotatedImage(dataUrl: string, annotationCanvas: HTMLCanvasElement) {
    const image = await loadImage(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = annotationCanvas.width;
    canvas.height = annotationCanvas.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建标注画布");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    context.drawImage(annotationCanvas, 0, 0);
    return canvas.toDataURL("image/png");
}

function loadImage(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("读取原图失败"));
        image.src = src;
    });
}
