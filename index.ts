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

// typed stats response from /admin/api/stats

interface OmlxWaitingRequest {
    request_id: string;
    queue_position: number;
    elapsed_seconds: number;
    prompt_tokens: number;
}

interface OmlxPrefilling {
    request_id: string;
    processed: number;
    total: number;
    speed: number;
    eta: number | null;
    elapsed: number;
    phase: "prefill";
    detail: string | null;
}

interface OmlxGenerating {
    request_id: string;
    elapsed_seconds: number;
    generated_tokens: number;
    tokens_per_second: number;
    last_activity_age_seconds: number;
    prompt_tokens: number;
    max_tokens: number;
}

interface OmlxModel {
    id: string;
    estimated_size: number;
    estimated_size_formatted: string;
    actual_size: number;
    actual_size_formatted: string | null;
    pinned: boolean;
    is_loading: boolean;
    loading_elapsed_seconds: number | null;
    loading_estimated_seconds: number | null;
    loading_remaining_seconds_estimate: number | null;
    active_requests: number;
    waiting_requests: number;
    waiting: OmlxWaitingRequest[];
    activities: never[];
    prefilling: OmlxPrefilling[];
    generating: OmlxGenerating[];
    idle_seconds: number | null;
    ttl_remaining_seconds: number | null;
}

interface OmlxMemoryPressure {
    enabled: boolean;
    current_bytes: number;
    soft_bytes: number;
    hard_bytes: number;
    current_formatted: string;
    soft_formatted: string;
    hard_formatted: string;
    pressure_level: string;
}

interface OmlxActiveModels {
    models: OmlxModel[];
    model_memory_used: number;
    model_memory_max: number;
    memory_pressure: OmlxMemoryPressure | null;
    total_active_requests: number;
    total_waiting_requests: number;
}

interface OmlxEngineInfo {
    name: string;
    version: string;
    commit: string | null;
    url: string | null;
}

interface CacheWindow {
    prefix_hit_rate: number;
    prefix_hits: number;
    prefix_misses: number;
    prefix_match_efficiency: number;
    evictions: number;
    eviction_rate_per_min: number;
    ssd_hot_hits: number;
    ssd_disk_loads: number;
    ssd_hot_rate: number;
}

interface CacheCumulative {
    prefix_hits: number;
    prefix_misses: number;
    prefix_hit_rate: number;
    prefix_tokens_saved: number;
    prefix_match_efficiency: number;
    evictions: number;
    ssd_hot_hits: number;
    ssd_disk_loads: number;
    ssd_saves: number;
    hot_cache_evictions: number;
    hot_cache_promotions: number;
    ssd_hot_rate: number;
}

interface OmlxCacheRates {
    windows: {
        "1m": CacheWindow;
        "5m": CacheWindow;
        "15m": CacheWindow;
    };
    cumulative: CacheCumulative;
}

interface OmlxCacheModel {
    id: string;
    block_size: number;
    indexed_blocks: number;
    indexed_blocks_display: string;
    has_sub_block_cache: boolean;
    partial_block_skips: number;
    partial_tokens_skipped: number;
    last_partial_tokens_skipped: number;
    last_tokens_to_next_block: number;
    num_files: number;
    total_size_bytes: number;
    max_size_bytes: number;
    hot_cache_max_bytes: number;
    hot_cache_size_bytes: number;
    hot_cache_entries: number;
    cache_rates: OmlxCacheRates;
}

interface OmlxRuntimeCache {
    base_path: string;
    ssd_cache_dir: string;
    response_state_dir: string;
    models: OmlxCacheModel[];
    total_num_files: number;
    total_size_bytes: number;
    effective_block_sizes: number[];
    disk_max_bytes: number;
    hot_cache_max_bytes: number;
    hot_cache_size_bytes: number;
    hot_cache_entries: number;
}

interface OmlxStatsResponse {
    total_tokens_served: number;
    total_cached_tokens: number;
    cache_efficiency: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_requests: number;
    avg_prefill_tps: number;
    avg_generation_tps: number;
    uptime_seconds: number;
    host: string;
    port: number;
    api_key: string;
    cli_prefix: string;
    claude_code_context_scaling_enabled: boolean;
    claude_code_target_context_size: number;
    engines: Record<string, OmlxEngineInfo>;
    active_models: OmlxActiveModels;
    runtime_cache: OmlxRuntimeCache;
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

// state — current request model id from fetch intercept, used to find exact model in stats
let activeModelId: string | null = null;

interface OmlxStreamUsage {
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

let lastChunk: { model: string; usage: OmlxStreamUsage } | null = null;
let lastTpsDisplay: string | null = null;
let turnCtx: { ui: { setStatus(key: string, text: string | undefined): void; setWorkingMessage(msg: string): void }; hasUI: boolean } | null = null;
let activePollers: ReturnType<typeof setInterval>[] = [];
let lastCachedTokens = 0; // baseline partial_tokens_skipped when preparing starts

// ui helpers

const downArrow = "↓";
const upArrow = "↑";

function fmtTime(seconds: number | undefined): string {
    if (!seconds || seconds <= 0) return "";
    const ms = seconds * 1000;
    return ms < 1000 ? `${Math.round(ms)}ms` : `${seconds.toFixed(2).replace(/\.?0+$/, "")}s`;
}

function buildStatus(usage: OmlxStreamUsage): string {
    const tps = usage.generation_tokens_per_second ?? 0;
    const ptsp = usage.prompt_tokens_per_second ?? 0;
    let out = `${downArrow}${tps.toFixed(1)} tok/s`;
    const genT = fmtTime(usage.generation_duration);
    if (genT) out += ` (${genT})`;
    if (ptsp > 0) {
        let part = ` | In: ${upArrow}${ptsp.toFixed(1)} tok/s`;
        const promptT = fmtTime(usage.prompt_eval_duration);
        if (promptT) part += ` (${promptT})`;
        out += part;
    }
    return out;
}

function updateStatus(usage: OmlxStreamUsage) {
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
        const stats = await (await fetch(adminUrl())).json() as OmlxStatsResponse;
        const am = stats.active_models;
        if (!am) return;

        // find the exact model for the current request, fallback to first
        const model = activeModelId
            ? am.models.find(m => m.id === activeModelId) ?? am.models[0]
            : am.models[0];
        if (!model) return;

        const mp = am.memory_pressure;
        const memCurrent = mp?.current_bytes ?? 0;
        const memUsed = mp?.current_formatted.toLowerCase() ?? "0gb";
        const memHard = mp?.hard_formatted.toLowerCase() ?? "0gb";
        const memTag = `${memUsed}/${memHard} used`;

        switch (true) {
            // model loading
            case model.is_loading: {
                const eta = Math.round((model.loading_remaining_seconds_estimate ?? 0) * 10) / 10;
                const pct = Math.round((memCurrent / (model.estimated_size || 1)) * 1000) / 10;
                updateWorking(`Loading model... (${pct.toFixed(1)}% complete, ${eta.toFixed(1)}s remaining, ${memTag})`, "loading");
                break;
            }

            // active prefill
            case model.prefilling.length > 0: {
                const p = model.prefilling[0];
                const total = p.total;
                const processed = p.processed;
                const pct = total > 0 ? Math.round((processed / total) * 1000) / 10 : 0;
                // eta can be null early in prefill; calc from elapsed progress
                const eta = p.eta ?? (p.elapsed > 0 ? Math.round((p.elapsed / Math.max(processed, 1)) * (total - processed)) : 0);
                updateWorking(`Prefilling... (${pct.toFixed(1)}% complete, ${eta.toFixed(1)}s remaining, ${memTag})`, "prefill");
                if (lastChunk?.usage) updateStatus(lastChunk.usage);
                break;
            }

            // active generation
            case model.generating.length > 0: {
                const g = model.generating[0];
                const speed = g.tokens_per_second;
                const elapsed = g.elapsed_seconds;
                const genPct = g.max_tokens > 0 ? Math.round((g.generated_tokens / g.max_tokens) * 1000) / 10 : 0;
                updateWorking(`Generating... (${genPct.toFixed(1)}% tok budget, ${speed.toFixed(1)} tok/s, ${elapsed.toFixed(1)}s elapsed, ${memTag})`, "gen");
                if (lastChunk?.usage) updateStatus(lastChunk.usage);
                break;
            }

            // idle / preparing — track cache warmup progress
            default: {
                const waiting = model.waiting[0];
                const cacheModel = stats.runtime_cache?.models.find(c => c.id === model.id);
                const cachedTokens = cacheModel?.partial_tokens_skipped ?? 0;

                // reset baseline only when model is truly idle with no pending request
                if (!waiting) {
                    lastCachedTokens = cachedTokens;
                }
                const cachedDelta = waiting ? cachedTokens - lastCachedTokens : 0;

                const promptTokens = waiting?.prompt_tokens ?? 0;
                const cachedPct = promptTokens > 0 ? Math.min(100, Math.round((cachedDelta / promptTokens) * 100)) : 0;
                const queueTime = waiting?.elapsed_seconds ?? 0;

                let parts = [];
                if (cachedPct > 0) parts.push(`${cachedPct}% cached`);
                if (queueTime > 0) parts.push(`${queueTime.toFixed(1)}s queued`);
                parts.push(memTag);
                updateWorking(`Preparing... (${parts.join(', ')})`, "prepare");
                if (lastChunk?.usage) updateStatus(lastChunk.usage);
                break;
            }
        }
    } catch { }
}

// fetch interception

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
                            lastChunk = { model: chunk.model ?? "omlx", usage: chunk.usage };
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
        // grab model id for targeted stats lookup
        if (p?.model) activeModelId = p.model;
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
    activeModelId = null;
    lastCachedTokens = 0;
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
