import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

const DEFAULT_OMLX_BASE_URL = "http://127.0.0.1:8000/v1";
const LOG_FILE = "/tmp/omlx-cpp-tps.log";
const DEBUG = process.env.OMLX_CPP_EXTENSION_DEBUG === "1";
const EXTENSION_KEY = Symbol.for("pi-omlx-tps/loaded");

function log(...args: any[]) {
	if (!DEBUG) return;
	try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [omlx-cpp-tps] ${args.join(" ")}\n`); } catch {}
}

import fs from "node:fs";

// ─── Minimal omlx config helpers (shared with pi-omlx-picker) ─────────────

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
let currentModel: string = "omlx";
let lastTpsDisplay: string | null = null;

function formatTps(data: OmlxUsage): string | null {
	const tps = data.generation_tokens_per_second;
	const ptsp = data.prompt_tokens_per_second;
	const genMs = data.generation_duration;
	const promptMs = data.prompt_eval_duration;

	if (!tps || tps <= 0) return null;

	if (ptsp && ptsp > 0) {
		return `Out: ${downArrow}${Number(tps).toFixed(1)} tok/s${fmtTime(genMs) ? ` (${fmtTime(genMs)})` : ""} | In: ${upArrow}${Number(ptsp).toFixed(1)} tok/s${fmtTime(promptMs) ? ` (${fmtTime(promptMs)})` : ""}`;
	}
	return `${downArrow}${Number(tps).toFixed(1)} tok/s${fmtTime(genMs) ? ` (${fmtTime(genMs)})` : ""}`;
}

function fmtTime(seconds: number | undefined): string {
	if (!seconds || seconds <= 0) return "";
	const ms = seconds * 1000;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${seconds.toFixed(2).replace(/\.?0+$/, "")}s`;
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

// ─── Fetch interceptor ────────────────────────────────────────────────────

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
					const usage = parseUsageChunk(line);
					if (usage) {
						lastChunk = { model: currentModel, usage };
						log("USAGE:", JSON.stringify(usage));
					}
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

		// Extract model name from request body
		try {
			const payload = typeof input === "string" ? input : (init?.body ?? input?.body);
			if (payload) {
				const p = typeof payload === "string" ? JSON.parse(payload) : payload;
				if (p?.model) currentModel = p.model;
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
		if (!lastChunk?.usage) return;
		const display = formatTps(lastChunk.usage);
		if (display && ctx.hasUI && display !== lastTpsDisplay) {
			lastTpsDisplay = display;
			ctx.ui.setStatus("omlx-tps", display);
			log("Set status:", display);
		}
	});

	pi.on("turn_start", (event, ctx) => {
		lastChunk = null;
		lastTpsDisplay = null;
	});

	pi.on("session_shutdown", () => {
		lastChunk = null;
		lastTpsDisplay = null;
		globalThis.fetch = originalFetch;
		delete globalState[EXTENSION_KEY];
	});
}
