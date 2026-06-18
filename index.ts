import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

const DEFAULT_OMLX_BASE_URL = "http://127.0.0.1:8000/v1";
const LOG_FILE = "/tmp/omlx-tps.log";
const DEBUG = process.env.OMLX_TPS_EXTENSION_DEBUG === "1";
const EXTENSION_KEY = Symbol.for("pi-omlx-tps/loaded");

function log(...args: any[]) {
    if (!DEBUG) return;
    try {
        fs.appendFileSync(
            LOG_FILE,
            `[${new Date().toISOString()}] [omlx-cpp-tps] ${args.join(" ")}\n`,
        );
    } catch { }
}

import fs from "node:fs";

// Config
const PROVIDER_KEY = "omlx";

function getAuthStorage(): AuthStorage {
    return AuthStorage.create();
}

function loadOmlxCredential():
    | { baseUrl?: string; apiKey: string }
    | undefined {
    const raw = getAuthStorage().get(PROVIDER_KEY);
    if (!raw || !raw.type) return undefined;
    if (raw.type === "api_key" && raw.key) {
        return { baseUrl: (raw as any).baseUrl, apiKey: raw.key };
    }
    if (raw.type === "oauth" && raw.access) {
        return { baseUrl: (raw as any).baseUrl, apiKey: raw.access };
    }
    return undefined;
}

let cachedConfig: { apiRoot: string; apiKey: string } | null = null;

function readOmlxConfig(): { apiRoot: string; apiKey: string } | null {
    const envUrl = process.env.OMLX_BASE_URL;
    const envKey = process.env.OMLX_API_KEY;

    if (envKey) {
        const apiRoot = envUrl ? normalizeBaseUrl(envUrl) : DEFAULT_OMLX_BASE_URL;
        return { apiRoot, apiKey: envKey };
    }

    const stored = loadOmlxCredential();
    if (stored?.apiKey) {
        const apiRoot = normalizeBaseUrl(stored.baseUrl ?? envUrl ?? "");
        return { apiRoot, apiKey: stored.apiKey };
    }

    return null;
}

function resolveOmlxConfig(): { apiRoot: string; apiKey: string } | null {
    if (cachedConfig) return cachedConfig;
    cachedConfig = readOmlxConfig();
    return cachedConfig;
}

function normalizeBaseUrl(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (!trimmed) return DEFAULT_OMLX_BASE_URL;
    return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// Formatting

const downArrow = "↓";
const upArrow = "↑";

interface OmlxUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    time_to_first_token?: number;
    total_time?: number;
    prompt_eval_duration?: number;
    generation_duration?: number;
    prompt_tokens_per_second?: number;
    generation_tokens_per_second?: number;
    model_load_duration?: number;
}

interface LastChunk {
    model: string;
    usage: OmlxUsage;
}

let lastChunk: LastChunk | null = null;
let lastTpsDisplay: string | null = null;
let turnCtx: {
    ui: {
        setStatus(key: string, text: string | undefined): void;
        setWorkingMessage(msg: string): void;
    };
    hasUI: boolean;
} | null = null;

function fmtTime(seconds: number | undefined): string {
    if (!seconds || seconds <= 0) return "";
    const ms = seconds * 1000;
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${seconds.toFixed(2).replace(/\.?0+$/, "")}s`;
}

// Stat endpoint polling

let activePollers: ReturnType<typeof setInterval>[] = [];
let pollTick = 0;

function adminUrl(): string {
    const cfg = resolveOmlxConfig();
    if (!cfg) return DEFAULT_OMLX_BASE_URL.replace("/v1", "") + "/admin/api/stats";
    // apiRoot already has /v1, strip it to get base, then add /admin/api/stats
    return cfg.apiRoot.replace(/\/v1$/, "") + "/admin/api/stats";
}

async function pollStats(): Promise<void> {
    pollTick++;
    try {
        const stats = await (await fetch(adminUrl())).json();
        const models = stats?.active_models?.models;
        if (!models || !Array.isArray(models)) return;
        const memPressure = stats?.active_models?.memory_pressure;
        const memCurrent = memPressure?.current_bytes ?? 0; // for loading
        const memUsedStr = memPressure?.current_formatted.toLowerCase() ?? "0gb";
        const memHardStr = memPressure?.hard_formatted.toLowerCase() ?? "0gb";

        for (const m of models) {
            if (!m.is_loading && !m.prefilling[0] && !m.generating[0]) {
                const workingMsg = `Preparing... (${memUsedStr}/${memHardStr} used)`;
                if (turnCtx?.hasUI) turnCtx.ui.setWorkingMessage(workingMsg);
                log("thinking:", workingMsg);
                continue;
            }

            // determine state
            if (m.is_loading) {
                const eta = Math.round(m?.loading_remaining_seconds_estimate * 10) / 10;
                const pct = Math.round((memCurrent / m.estimated_size) * 1000) / 10;
                const workingMsg = `Loading model... (${pct.toFixed(1)}% complete, ${eta.toFixed(1)}s remaining, ${memUsedStr}/${memHardStr} used)`;
                if (turnCtx?.hasUI) turnCtx.ui.setWorkingMessage(workingMsg);
                log("loading:", workingMsg);
                continue;
            }

            const prefilling = m.prefilling[0];
            const g = prefilling ? m.prefilling[0] : m.generating[0];
            const type = prefilling ? "Prefilling" : "Generating";

            const total = g.total ?? g.prompt_tokens ?? 0;
            const processed = g.processed ?? g.generated_tokens ?? 0;
            const pct = total > 0 ? Math.round((processed / total) * 1000) / 10 : 0;
            const elapsed = Math.round(g.elapsed ?? g.elapsed_seconds ?? 0);

            const speed = Math.round(g.speed ?? g.tokens_per_second ?? 0);
            const calcEta = speed > 0 ? Math.round((total - processed) / speed) : 0;
            const eta = g.eta ?? calcEta ?? 0;

            const progressMsg = prefilling
                ? `${pct.toFixed(1)}% complete, ${eta.toFixed(1)}s remaining,`
                : `${speed.toFixed(1)} tok/s, ${elapsed.toFixed(1)}s elapsed,`;

            const workingMsg = `${type}... (${progressMsg} ${memUsedStr}/${memHardStr} used)`;

            if (turnCtx?.hasUI) turnCtx.ui.setWorkingMessage(workingMsg);
            log(`${type}:`, workingMsg);

            // status bar — final TPS after generation
            if (lastChunk?.usage) {
                const tpsFinal = lastChunk.usage.generation_tokens_per_second ?? 0;
                const ptsp = lastChunk.usage.prompt_tokens_per_second ?? 0;
                const genMs = lastChunk.usage.generation_duration;
                const promptMs = lastChunk.usage.prompt_eval_duration;
                let status = `${downArrow}${tpsFinal.toFixed(1)} tok/s${fmtTime(genMs) ? ` (${fmtTime(genMs)})` : ""}`;
                if (ptsp && ptsp > 0) {
                    status += ` | In: ${upArrow}${ptsp.toFixed(1)} tok/s${fmtTime(promptMs) ? ` (${fmtTime(promptMs)})` : ""}`;
                }
                if (status !== lastTpsDisplay) {
                    lastTpsDisplay = status;
                    if (turnCtx?.hasUI) turnCtx.ui.setStatus("omlx-tps", status);
                }
            }

            log("poll live:", workingMsg);
        }
    } catch { }
}

// Fetch interception

function captureOmlxTimings(
    body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let buffer = "";
    const decoder = new TextDecoder();

    return new ReadableStream({
        async start(controller) {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    const jsonStr = line.slice(6);
                    if (jsonStr === "[DONE]") continue;
                    try {
                        const chunk = JSON.parse(jsonStr);
                        if (chunk.usage) {
                            lastChunk = { model: "omlx", usage: chunk.usage };
                            log("USAGE:", JSON.stringify(chunk.usage));
                        }
                    } catch { }
                }

                controller.enqueue(value);
            }

            decoder.decode();
            controller.close();
        },
        cancel(reason?: any) {
            reader.cancel(reason);
        },
    });
}

function stopActivePollers() {
    for (const id of activePollers) clearInterval(id);
    activePollers = [];
}

function isOmlxRequest(input: any): boolean {
    const url = typeof input === "string" ? input : input?.url;
    if (typeof url !== "string") return false;
    if (!url.includes("/chat/completions")) return false;
    return !!resolveOmlxConfig();
}

// Pi extension

export default function (pi: ExtensionAPI): void {
    const globalState = globalThis as Record<PropertyKey, unknown>;
    if (globalState[EXTENSION_KEY]) return;
    globalState[EXTENSION_KEY] = true;

    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: any, init?: any) => {
        if (!isOmlxRequest(input)) {
            return originalFetch(input, init);
        }

        try {
            const payload =
                typeof input === "string" ? input : (init?.body ?? input?.body);
            if (payload) {
                const p = typeof payload === "string" ? JSON.parse(payload) : payload;
                if (p?.model) {
                }
                if (!p.stream_options) {
                    p.stream_options = { include_usage: true };
                    const newBody = JSON.stringify(p);
                    if (typeof input === "string") {
                        init = { ...init, body: newBody };
                    } else if (input) {
                        input.body = newBody;
                    }
                }
            }
        } catch { }

        const response = await originalFetch(input, init);
        if (response.ok && response.body) {
            return new Response(captureOmlxTimings(response.body), {
                status: response.status,
                statusText: response.statusText,
                headers: new Headers(response.headers),
            });
        }
        return response;
    };

    pi.on("turn_end", (event, ctx) => {
        stopActivePollers();
        if (!lastChunk?.usage) return;
        const tps = lastChunk.usage.generation_tokens_per_second ?? 0;
        const ptsp = lastChunk.usage.prompt_tokens_per_second ?? 0;
        const genMs = lastChunk.usage.generation_duration;
        const promptMs = lastChunk.usage.prompt_eval_duration;
        let status = `${downArrow}${tps.toFixed(1)} tok/s${fmtTime(genMs) ? ` (${fmtTime(genMs)})` : ""}`;
        if (ptsp && ptsp > 0) {
            status += ` | In: ${upArrow}${ptsp.toFixed(1)} tok/s${fmtTime(promptMs) ? ` (${fmtTime(promptMs)})` : ""}`;
        }
        if (status !== lastTpsDisplay && ctx.hasUI) {
            lastTpsDisplay = status;
            ctx.ui.setStatus("omlx-tps", status);
            log("turn_end status:", status);
        }
    });

    pi.on("before_agent_start", (event, ctx) => {
        lastChunk = null;
        lastTpsDisplay = null;
        pollTick = 0;
        turnCtx = ctx;
        cachedConfig = null; // refresh config each turn
        log("turn_start: stored ctx, hasUI:", ctx.hasUI);
        if (!resolveOmlxConfig()) return; // skip polling if no config
        const loadPollInterval = setInterval(pollStats, 300);
        activePollers.push(loadPollInterval);
    });

    pi.on("session_shutdown", () => {
        lastChunk = null;
        lastTpsDisplay = null;
        turnCtx = null;
        cachedConfig = null;
        stopActivePollers();
        globalThis.fetch = originalFetch;
        delete globalState[EXTENSION_KEY];
    });
}
