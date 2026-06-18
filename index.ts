import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";

const DEFAULT_OMLX_BASE_URL = "http://127.0.0.1:8000/v1";
const LOG_FILE = "/tmp/omlx-tps.log";
const DEBUG = process.env.OMLX_TPS_EXTENSION_DEBUG === "1";
const EXTENSION_KEY = Symbol.for("pi-omlx-tps/loaded");

function log(...args: any[]) {
    if (!DEBUG) return;
    try {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [omlx-tps] ${args.join(" ")}\n`);
    } catch { }
}

// config — cached per turn, invalidated on turn start / shutdown
let cachedConfig: { apiRoot: string; apiKey: string } | null = null;

function resolveOmlxConfig(): { apiRoot: string; apiKey: string } | null {
    if (cachedConfig) return cachedConfig;
    const envUrl = process.env.OMLX_BASE_URL;
    const envKey = process.env.OMLX_API_KEY;

    if (envKey) {
        return { apiRoot: envUrl ? normalizeUrl(envUrl) : DEFAULT_OMLX_BASE_URL, apiKey: envKey };
    }

    const raw = AuthStorage.create().get("omlx");
    const storedUrl = (raw as any)?.baseUrl ?? envUrl;
    if (raw?.type === "api_key" && raw.key) {
        return { apiRoot: normalizeUrl(storedUrl ?? ""), apiKey: raw.key };
    }
    if (raw?.type === "oauth" && raw.access) {
        return { apiRoot: normalizeUrl(storedUrl ?? ""), apiKey: raw.access };
    }

    return null;
}

function normalizeUrl(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (!trimmed) return DEFAULT_OMLX_BASE_URL;
    return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function adminUrl(): string {
    const cfg = resolveOmlxConfig();
    const base = cfg ? cfg.apiRoot.replace(/\/v1$/, "") : DEFAULT_OMLX_BASE_URL.replace("/v1", "");
    return base + "/admin/api/stats";
}

// state

let lastChunk: { model: string; usage: OmlxUsage } | null = null;
let lastTpsDisplay: string | null = null;
let turnCtx: { ui: { setStatus(key: string, text: string | undefined): void; setWorkingMessage(msg: string): void }; hasUI: boolean } | null = null;
let activePollers: ReturnType<typeof setInterval>[] = [];

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

// ui helpers

const downArrow = "↓";
const upArrow = "↑";

function fmtTime(seconds: number | undefined): string {
    if (!seconds || seconds <= 0) return "";
    const ms = seconds * 1000;
    return ms < 1000 ? `${Math.round(ms)}ms` : `${seconds.toFixed(2).replace(/\.?0+$/, "")}s`;
}

function buildStatus(usage: OmlxUsage): string {
    const tps = usage.generation_tokens_per_second ?? 0;
    const ptsp = usage.prompt_tokens_per_second ?? 0;
    let status = `${downArrow}${tps.toFixed(1)} tok/s`;
    const genT = fmtTime(usage.generation_duration);
    if (genT) status += ` (${genT})`;
    if (ptsp && ptsp > 0) {
        let part = ` | In: ${upArrow}${ptsp.toFixed(1)} tok/s`;
        const promptT = fmtTime(usage.prompt_eval_duration);
        if (promptT) part += ` (${promptT})`;
        status += part;
    }
    return status;
}

function updateStatus(usage: OmlxUsage) {
    const status = buildStatus(usage);
    if (status !== lastTpsDisplay) {
        lastTpsDisplay = status;
        if (turnCtx?.hasUI) turnCtx.ui.setStatus("omlx-tps", status);
    }
}

function updateWorking(msg: string, label: string) {
    if (turnCtx?.hasUI) turnCtx.ui.setWorkingMessage(msg);
    log(label, msg);
}

// stats polling

async function pollStats(): Promise<void> {
    try {
        const stats = await (await fetch(adminUrl())).json();
        const models = stats?.active_models?.models;
        if (!models || !Array.isArray(models)) return;

        const mp = stats?.active_models?.memory_pressure;
        const memCurrent = mp?.current_bytes ?? 0;
        const memUsedStr = mp?.current_formatted.toLowerCase() ?? "0gb";
        const memHardStr = mp?.hard_formatted.toLowerCase() ?? "0gb";

        for (const m of models) {
            // model idle — preparing
            if (!m.is_loading && !m.prefilling[0] && !m.generating[0]) {
                updateWorking(`Preparing... (${memUsedStr}/${memHardStr} used)`, "thinking");
                // still show cached tps from last stream
                if (lastChunk?.usage) updateStatus(lastChunk.usage);
                continue;
            }

            // model loading
            if (m.is_loading) {
                const eta = Math.round((m.loading_remaining_seconds_estimate ?? 0) * 10) / 10;
                const pct = Math.round((memCurrent / (m.estimated_size || 1)) * 1000) / 10;
                updateWorking(`Loading model... (${pct.toFixed(1)}% complete, ${eta.toFixed(1)}s remaining, ${memUsedStr}/${memHardStr} used)`, "loading");
                continue;
            }

            // active: prefill or generate
            const prefilling = m.prefilling[0];
            const g = prefilling || m.generating[0];
            const isGen = !prefilling;
            const total = g.total ?? g.prompt_tokens ?? 0;
            const processed = g.processed ?? g.generated_tokens ?? 0;
            const pct = total > 0 ? Math.round((processed / total) * 1000) / 10 : 0;
            const elapsed = Math.round(g.elapsed ?? g.elapsed_seconds ?? 0);
            const speed = Math.round(g.speed ?? g.tokens_per_second ?? 0);
            const eta = g.eta ?? (speed > 0 ? Math.round((total - processed) / speed) : 0);

            const progressMsg = isGen
                ? `${speed.toFixed(1)} tok/s, ${elapsed.toFixed(1)}s elapsed,`
                : `${pct.toFixed(1)}% complete, ${eta.toFixed(1)}s remaining,`;

            updateWorking(`${isGen ? "Generating" : "Prefilling"}... (${progressMsg} ${memUsedStr}/${memHardStr} used)`, isGen ? "gen" : "prefill");

            // status bar from last captured stream usage
            if (lastChunk?.usage) updateStatus(lastChunk.usage);
        }
    } catch { }
}

// fetch interception — capture SSE usage chunks

function captureOmlxTimings(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
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
                            log("usage:", JSON.stringify(chunk.usage));
                        }
                    } catch { }
                }

                controller.enqueue(value);
            }
            controller.close();
        },
        cancel(reason?: any) { reader.cancel(reason); },
    });
}

function ensureStreamOptions(input: any, init?: any) {
    try {
        const payload = typeof input === "string" ? input : (init?.body ?? input?.body);
        if (!payload) return;
        const p = typeof payload === "string" ? JSON.parse(payload) : payload;
        if (!p.stream_options) {
            p.stream_options = { include_usage: true };
            const newBody = JSON.stringify(p);
            if (typeof input === "string") {
                init = { ...init, body: newBody };
            } else if (input) {
                input.body = newBody;
            }
        }
    } catch { }
}

function isOmlxRequest(input: any): boolean {
    const url = typeof input === "string" ? input : input?.url;
    return typeof url === "string" && url.includes("/chat/completions") && !!resolveOmlxConfig();
}

function stopPollers() {
    for (const id of activePollers) clearInterval(id);
    activePollers = [];
}

function resetState() {
    lastChunk = null;
    lastTpsDisplay = null;
}

// extension entry

export default function (pi: ExtensionAPI): void {
    const globalState = globalThis as Record<PropertyKey, unknown>;
    if (globalState[EXTENSION_KEY]) return;
    globalState[EXTENSION_KEY] = true;

    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: any, init?: any) => {
        if (!isOmlxRequest(input)) return originalFetch(input, init);

        ensureStreamOptions(input, init);

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

    pi.on("before_agent_start", (_event, ctx) => {
        resetState();
        turnCtx = ctx;
        cachedConfig = null; // refresh config each turn
        log("turn_start, hasUI:", ctx.hasUI);
        if (!resolveOmlxConfig()) return; // skip polling if no config
        activePollers.push(setInterval(pollStats, 300));
    });

    pi.on("turn_end", (_event, ctx) => {
        stopPollers();
        if (lastChunk?.usage && ctx.hasUI) {
            const status = buildStatus(lastChunk.usage);
            if (status !== lastTpsDisplay) {
                lastTpsDisplay = status;
                ctx.ui.setStatus("omlx-tps", status);
                log("turn_end status:", status);
            }
        }
    });

    pi.on("session_shutdown", () => {
        resetState();
        turnCtx = null;
        cachedConfig = null;
        stopPollers();
        globalThis.fetch = originalFetch;
        delete globalState[EXTENSION_KEY];
    });
}
