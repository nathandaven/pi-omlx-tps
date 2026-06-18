import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

const DEFAULT_OMLX_BASE_URL = "http://127.0.0.1:8000/v1";
const ADMIN_URL = "http://127.0.0.1:8000/admin/api/stats";
const LOG_FILE = "/tmp/omlx-cpp-tps.log";
const DEBUG = process.env.OMLX_CPP_EXTENSION_DEBUG === "1";
const EXTENSION_KEY = Symbol.for("pi-omlx-tps/loaded");

function log(...args: any[]) {
	if (!DEBUG) return;
	try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [omlx-cpp-tps] ${args.join(" ")}\n`); } catch {}
}

import fs from "node:fs";

// ─── Minimal omlx config helpers ──────────────────────────────────────────

const PROVIDER_KEY = "omlx";

function getAuthStorage(): AuthStorage {
	return AuthStorage.create();
}

function loadOmlxCredential(): { baseUrl?: string; apiKey: string } | undefined {
	const raw = getAuthStorage().get(PROVIDER_KEY);
	if (!raw) return undefined;
	if (raw.type === "api_key" && raw.key) {
		return { baseUrl: (raw as any).baseUrl, apiKey: raw.key };
	}
	if (raw.type === "oauth" && raw.access) {
		return { baseUrl: (raw as any).baseUrl, apiKey: raw.access };
	}
	return undefined;
}

function resolveOmlxConfig(): { apiRoot: string; apiKey: string } | null {
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

function normalizeBaseUrl(raw: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	if (!trimmed) return DEFAULT_OMLX_BASE_URL;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// ─── TPS formatting ───────────────────────────────────────────────────────

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
let turnCtx: { ui: { setStatus(key: string, text: string | undefined): void; setWorkingMessage(msg: string): void }, hasUI: boolean } | null = null;

function fmtTime(seconds: number | undefined): string {
	if (!seconds || seconds <= 0) return "";
	const ms = seconds * 1000;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${seconds.toFixed(2).replace(/\.?0+$/, "")}s`;
}

function fmtTimeMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

function parseUsageChunk(line: string): OmlxUsage | null {
	if (!line.startsWith("data: ")) return null;
	const jsonStr = line.slice(6);
	if (jsonStr === "[DONE]") return null;
	try {
		const chunk = JSON.parse(jsonStr);
		return chunk.usage ?? null;
	} catch {
		return null;
	}
}

// ─── Stats polling during stream ──────────────────────────────────────────

let activePollers: ReturnType<typeof setInterval>[] = [];
let pollTick = 0;

async function pollStats(): Promise<void> {
	pollTick++;
	try {
		const stats = await (await fetch(ADMIN_URL)).json();
		const models = stats?.active_models?.models;
		if (!models || !Array.isArray(models)) return;

		const memPressure = stats?.active_models?.memory_pressure;
		let memLine = "";
		if (memPressure) {
			memLine = `MEM ${memPressure.current_formatted}`;
			if (memPressure.soft_formatted && memPressure.soft_formatted !== memPressure.current_formatted) {
				memLine += ` / ${memPressure.soft_formatted}`;
			}
		}

		for (const m of models) {
			if (!m.generating || m.generating.length === 0) continue;
			const g = m.generating[0];

			// skip stale — first tick or zero elapsed
			if (pollTick <= 1 || !g.elapsed_seconds || g.elapsed_seconds <= 0.05) return;

			const tps = g.tokens_per_second ?? 0;
			const elapsed = g.elapsed_seconds;
			const genTokens = g.generated_tokens ?? 0;
			const maxTokens = g.max_tokens ?? 0;
			const nPp = m.generating.length;
			const totalReqs = m.active_requests ?? 1;
			const obsMem = m.actual_size_formatted ?? "";
			const estMem = m.estimated_size_formatted ?? "";

			const pct = maxTokens > 0 ? Math.round(genTokens / maxTokens * 100) : 0;
			const eta = tps > 0 ? fmtTimeMs((maxTokens - genTokens) / tps * 1000) : "?s";

			if (!turnCtx || !turnCtx.hasUI) return;

			// build: model | PP$req | TPS | progress | tokens | time | ETA | MEM
			const workingMsg = `${m.id} · ${nPp} PP · ${totalReqs} req · ${downArrow}${tps.toFixed(0)} tok/s | ${pct}% (${genTokens}/${maxTokens}) ${fmtTimeMs(elapsed * 1000)} | ${eta}${obsMem ? ` | ~${obsMem}${estMem && estMem !== obsMem ? ` / ${estMem}` : ""}` : ""}${memLine ? ` · ${memLine}` : ""}`;
			turnCtx.ui.setWorkingMessage(workingMsg);

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
					turnCtx.ui.setStatus("omlx-tps", status);
				}
			}

			log("poll live:", workingMsg);
		}
	} catch {}
}

// ─── Fetch interceptor ────────────────────────────────────────────────────

function captureOmlxTimings(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const capturedCtx = turnCtx;
	const reader = body.getReader();
	let buffer = "";
	const decoder = new TextDecoder();

	return new ReadableStream({
		async start(controller) {
			// start polling as soon as stream starts
			if (capturedCtx) {
				const pollInterval = setInterval(pollStats, 300);
				activePollers.push(pollInterval);
			}

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const usage = parseUsageChunk(line);
					if (usage) {
						lastChunk = { model: "omlx", usage };
						log("USAGE:", JSON.stringify(usage));
					}
				}

				controller.enqueue(value);
			}

			// stop polling when stream ends
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

// ─── Extension entry point ────────────────────────────────────────────────

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
			const payload = typeof input === "string" ? input : (init?.body ?? input?.body);
			if (payload) {
				const p = typeof payload === "string" ? JSON.parse(payload) : payload;
				if (p?.model) {
					// don't set currentModel — not used with stats API approach
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
		} catch {}

		const response = await originalFetch(input, init);
		if (response.ok && response.body) {
			return new Response(captureOmlxTimings(response.body), {
				status: response.status,
				headers: Object.fromEntries(response.headers),
			});
		}
		return response;
	};

	pi.on("turn_end", (event, ctx) => {
		// final refresh after stream is fully consumed
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

	pi.on("turn_start", (event, ctx) => {
		lastChunk = null;
		lastTpsDisplay = null;
		pollTick = 0;
		turnCtx = ctx;
		log("turn_start: stored ctx, hasUI:", ctx.hasUI);
	});

	pi.on("session_shutdown", () => {
		lastChunk = null;
		lastTpsDisplay = null;
		turnCtx = null;
		stopActivePollers();
		globalThis.fetch = originalFetch;
		delete globalState[EXTENSION_KEY];
	});
}
