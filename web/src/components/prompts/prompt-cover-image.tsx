"use client";

import { ImageIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

export function PromptCoverImage({ src, title, className, imageClassName }: { src?: string; title: string; className?: string; imageClassName?: string }) {
    const [failed, setFailed] = useState(false);
    const canLoad = Boolean(src && !failed);
    const tone = useMemo(() => coverTone(title), [title]);

    useEffect(() => {
        setFailed(false);
    }, [src]);

    return (
        <div className={cn("relative overflow-hidden bg-stone-900", className)} style={{ background: tone.background }}>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,rgba(255,255,255,.18),transparent_28%),linear-gradient(145deg,rgba(255,255,255,.08),transparent_42%)]" />
            <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.06)_1px,transparent_1px)] bg-[size:24px_24px] opacity-25" />
            <div className="absolute inset-x-4 top-4 flex items-center justify-between text-white/70">
                <ImageIcon className="size-4" />
                <span className="max-w-[70%] truncate text-xs font-medium">{title}</span>
            </div>
            <div className="absolute bottom-4 left-4 right-4">
                <div className="h-1.5 w-16 rounded-full bg-white/45" />
                <div className="mt-2 h-1.5 w-28 rounded-full bg-white/25" />
            </div>
            {canLoad ? <img src={src} alt={title} className={cn("absolute inset-0 h-full w-full object-cover", imageClassName)} onError={() => setFailed(true)} /> : null}
        </div>
    );
}

function coverTone(value: string) {
    const palettes = [
        ["#111827", "#0f766e", "#f59e0b"],
        ["#18181b", "#be123c", "#38bdf8"],
        ["#0f172a", "#7c3aed", "#22c55e"],
        ["#1c1917", "#2563eb", "#f97316"],
        ["#052e16", "#0891b2", "#f43f5e"],
    ];
    const hash = Array.from(value).reduce((total, char) => total + char.charCodeAt(0), 0);
    const [base, accent, glow] = palettes[hash % palettes.length];
    return { background: `radial-gradient(circle at 72% 18%, ${glow}66, transparent 28%), radial-gradient(circle at 18% 78%, ${accent}88, transparent 34%), ${base}` };
}
