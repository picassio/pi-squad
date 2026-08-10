import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { Squad, Task } from "./types.js";

export const SPEC_CHUNK_BYTES = 32_768;
export const MAX_SPEC_BYTES = 1_048_576;
const MAX_GOAL_BYTES = 65_536;
const MAX_TITLE_BYTES = 1_024;
const MAX_DESCRIPTION_BYTES = 131_072;
const MAX_EMBEDDED_BYTES = 524_288;
const MAX_ARTIFACT_PATH_BYTES = 32_768;
const HASH = /^[a-f0-9]{64}$/;
const TASK_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const isFileSpecTaskId = (value: string): boolean => TASK_ID.test(value);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const THINKING = new Set([null, "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const BASE64_RUN = /(?:data:[^,;]+;base64,)?[A-Za-z0-9+/]{4097,}={0,2}/;
const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

export interface FileSpecTask {
	id: string; title: string; description: string; agent: string;
	depends: string[]; inheritContext: boolean; artifactRefs: string[];
}
export interface FileSpecArtifact {
	id: string; path: string; sha256: string; bytes: number; purpose: string; mediaType?: string;
}
export interface FileSpec {
	schemaVersion: 1;
	goal: string;
	tasks: FileSpecTask[];
	agents: Record<string, { model: string | null; thinking: string | null }>;
	config: { maxConcurrency: number; autoUnblock: boolean; maxRetries: number };
	artifacts: FileSpecArtifact[];
}
export interface PreparedSpec { spec: FileSpec; raw: Buffer; sha256: string }
interface ChunkRecord {
	index: number; startByte: number; endByteExclusive: number; bytes: number; sha256: string;
	toolCallId: string; deliveredAt: string;
}
interface ChunkMetadata {
	version: 1; squadId: string; taskId: string; index: number; chunkCount: number;
	startByte: number; endByteExclusive: number; chunkBytes: number; chunkSha256: string;
	specBytes: number; specSha256: string;
}

function fail(code: string, message: string): never { throw new Error(`${code}: ${message}`); }
function exactKeys(value: unknown, allowed: readonly string[], where: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("SPEC_MALFORMED", `${where} must be an object`);
	for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("SPEC_MALFORMED", `unknown ${where} property "${key}"`);
}
function requireString(value: unknown, where: string, nonempty = false): asserts value is string {
	if (typeof value !== "string" || (nonempty && value.length === 0)) fail("SPEC_MALFORMED", `${where} must be ${nonempty ? "a nonempty " : "a "}string`);
}
function requireArray(value: unknown, where: string): asserts value is unknown[] {
	if (!Array.isArray(value)) fail("SPEC_MALFORMED", `${where} must be an array`);
}
function checkEmbedded(value: string, where: string, max: number): number {
	const measured = utf8Bytes(value);
	if (measured > max) fail("SPEC_TOO_LARGE", `${where} is ${measured} bytes; limit is ${max}; use an artifact reference`);
	if (BASE64_RUN.test(value)) fail("SPEC_TOO_LARGE", `${where} contains an oversized Base64/data-URI-like run; use an artifact reference`);
	return measured;
}

/** Strict JSON parser: JSON.parse semantics plus duplicate-object-key rejection. */
function parseJsonNoDuplicateKeys(text: string): unknown {
	let cursor = 0;
	const whitespace = (): void => { while (text[cursor] === " " || text[cursor] === "\t" || text[cursor] === "\r" || text[cursor] === "\n") cursor++; };
	const string = (): string => {
		const start = cursor++;
		while (cursor < text.length) {
			const char = text[cursor++];
			if (char === "\\") { cursor++; continue; }
			if (char === "\"") {
				try { return JSON.parse(text.slice(start, cursor)) as string; }
				catch { fail("SPEC_MALFORMED", "invalid JSON string"); }
			}
		}
		return fail("SPEC_MALFORMED", "unterminated JSON string");
	};
	const value = (): unknown => {
		whitespace();
		const char = text[cursor];
		if (char === "{") {
			cursor++; whitespace(); const result: Record<string, unknown> = {}; const keys = new Set<string>();
			if (text[cursor] === "}") { cursor++; return result; }
			while (true) {
				whitespace(); if (text[cursor] !== "\"") fail("SPEC_MALFORMED", "object key must be a string");
				const key = string(); if (keys.has(key)) fail("SPEC_MALFORMED", `duplicate object key "${key}"`); keys.add(key);
				whitespace(); if (text[cursor++] !== ":") fail("SPEC_MALFORMED", "missing colon after object key");
				result[key] = value(); whitespace(); const separator = text[cursor++];
				if (separator === "}") return result; if (separator !== ",") fail("SPEC_MALFORMED", "invalid object separator");
			}
		}
		if (char === "[") {
			cursor++; whitespace(); const result: unknown[] = []; if (text[cursor] === "]") { cursor++; return result; }
			while (true) { result.push(value()); whitespace(); const separator = text[cursor++]; if (separator === "]") return result; if (separator !== ",") fail("SPEC_MALFORMED", "invalid array separator"); }
		}
		if (char === "\"") return string();
		const rest = text.slice(cursor);
		for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
			if (rest.startsWith(literal)) { cursor += literal.length; return parsed; }
		}
		const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
		if (!match) fail("SPEC_MALFORMED", `invalid JSON value at byte ${Buffer.byteLength(text.slice(0, cursor), "utf8")}`);
		cursor += match[0].length; const parsed = Number(match[0]); if (!Number.isFinite(parsed)) fail("SPEC_MALFORMED", "non-finite number"); return parsed;
	};
	const parsed = value(); whitespace(); if (cursor !== text.length) fail("SPEC_MALFORMED", "trailing non-whitespace after JSON value"); return parsed;
}

function sameIdentity(a: fs.Stats, b: fs.Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
/** Open once, reject final symlinks, read all bytes, and detect in-place mutation. */
export function stableReadFile(filePath: string, code: "SPEC_UNSTABLE" | "ARTIFACT_UNSTABLE", maxBytes?: number): Buffer {
	let before: fs.Stats; try { before = fs.lstatSync(filePath); } catch (error) { fail(code, `cannot stat ${filePath}: ${(error as Error).message}`); }
	if (before.isSymbolicLink() || !before.isFile()) fail(code, `${filePath} must be a regular non-symlink file`);
	if (maxBytes !== undefined && before.size > maxBytes) fail("SPEC_TOO_LARGE", `canonical spec is ${before.size} bytes; limit is ${maxBytes}; use artifact references`);
	let fd: number | undefined;
	try {
		const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
		const opened = fs.fstatSync(fd); if (!sameIdentity(before, opened)) fail(code, `${filePath} changed while opening`);
		const chunks: Buffer[] = []; const buffer = Buffer.allocUnsafe(64 * 1024); let total = 0;
		while (true) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (count === 0) break; total += count; if (maxBytes !== undefined && total > maxBytes) fail("SPEC_TOO_LARGE", `canonical spec exceeds ${maxBytes} bytes; use artifact references`); chunks.push(Buffer.from(buffer.subarray(0, count))); }
		const after = fs.fstatSync(fd); if (!sameIdentity(opened, after) || total !== after.size) fail(code, `${filePath} changed while reading`);
		return Buffer.concat(chunks, total);
	} catch (error) {
		if (error instanceof Error && (error.message.startsWith(`${code}:`) || error.message.startsWith("SPEC_TOO_LARGE:"))) throw error;
		fail(code, `cannot securely read ${filePath}: ${(error as Error).message}`);
	} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ } }
	throw new Error("unreachable stable read state");
}

/** Hash an external artifact with constant memory while retaining the same stable-descriptor checks. */
function stableHashFile(filePath: string, code: "ARTIFACT_UNSTABLE"): { bytes: number; sha256: string } {
	let before: fs.Stats; try { before = fs.lstatSync(filePath); } catch (error) { fail(code, `cannot stat ${filePath}: ${(error as Error).message}`); }
	if (before.isSymbolicLink() || !before.isFile()) fail(code, `${filePath} must be a regular non-symlink file`);
	let fd: number | undefined;
	try {
		const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
		const opened = fs.fstatSync(fd); if (!sameIdentity(before, opened)) fail(code, `${filePath} changed while opening`);
		const digest = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); let total = 0;
		while (true) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (count === 0) break; digest.update(buffer.subarray(0, count)); total += count; }
		const after = fs.fstatSync(fd); if (!sameIdentity(opened, after) || total !== after.size) fail(code, `${filePath} changed while hashing`);
		return { bytes: total, sha256: digest.digest("hex") };
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(`${code}:`)) throw error;
		fail(code, `cannot securely hash ${filePath}: ${(error as Error).message}`);
	} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ } }
	throw new Error("unreachable stable hash state");
}

function validateSpec(parsed: unknown): FileSpec {
	exactKeys(parsed, ["schemaVersion", "goal", "tasks", "agents", "config", "artifacts"], "spec");
	if (parsed.schemaVersion !== 1) fail("SPEC_MALFORMED", "schemaVersion must equal 1");
	requireString(parsed.goal, "goal", true); let embeddedBytes = checkEmbedded(parsed.goal, "goal", MAX_GOAL_BYTES);
	requireArray(parsed.tasks, "tasks"); if (parsed.tasks.length < 1 || parsed.tasks.length > 128) fail("SPEC_MALFORMED", "tasks must contain 1..128 entries");
	if (!parsed.agents || typeof parsed.agents !== "object" || Array.isArray(parsed.agents)) fail("SPEC_MALFORMED", "agents must be an object");
	const agents = parsed.agents as Record<string, unknown>; const agentNames = Object.keys(agents);
	if (agentNames.length > 64) fail("SPEC_MALFORMED", "agents exceeds 64 entries");
	for (const [name, raw] of Object.entries(agents)) {
		if (!NAME.test(name)) fail("SPEC_MALFORMED", `invalid agent name "${name}"`);
		exactKeys(raw, ["model", "thinking"], `agent ${name}`);
		if (!(raw.model === null || typeof raw.model === "string") || !THINKING.has(raw.thinking as string | null)) fail("SPEC_MALFORMED", `invalid agent ${name}`);
		if (!("model" in raw) || !("thinking" in raw)) fail("SPEC_MALFORMED", `agent ${name} requires model and thinking`);
	}
	exactKeys(parsed.config, ["maxConcurrency", "autoUnblock", "maxRetries"], "config");
	const config = parsed.config;
	if (!Number.isInteger(config.maxConcurrency) || (config.maxConcurrency as number) < 1 || (config.maxConcurrency as number) > 64 || typeof config.autoUnblock !== "boolean" || !Number.isInteger(config.maxRetries) || (config.maxRetries as number) < 0 || (config.maxRetries as number) > 20) fail("SPEC_MALFORMED", "invalid config");
	for (const key of ["maxConcurrency", "autoUnblock", "maxRetries"]) if (!(key in config)) fail("SPEC_MALFORMED", `config requires ${key}`);

	const taskIds = new Set<string>(); const tasks = parsed.tasks as Record<string, unknown>[];
	for (const raw of tasks) {
		exactKeys(raw, ["id", "title", "description", "agent", "depends", "inheritContext", "artifactRefs"], "task");
		for (const key of ["id", "title", "description", "agent", "depends", "inheritContext", "artifactRefs"]) if (!(key in raw)) fail("SPEC_MALFORMED", `task requires ${key}`);
		requireString(raw.id, "task.id"); requireString(raw.title, "task.title", true); requireString(raw.description, "task.description"); requireString(raw.agent, "task.agent"); requireArray(raw.depends, "task.depends"); requireArray(raw.artifactRefs, "task.artifactRefs");
		if (!TASK_ID.test(raw.id) || taskIds.has(raw.id)) fail("SPEC_MALFORMED", `invalid or duplicate task id "${raw.id}"`); taskIds.add(raw.id);
		if (!agents[raw.agent]) fail("SPEC_MALFORMED", `task ${raw.id} uses undeclared agent ${raw.agent}`);
		if (typeof raw.inheritContext !== "boolean" || !raw.depends.every((d) => typeof d === "string") || new Set(raw.depends).size !== raw.depends.length || !raw.artifactRefs.every((a) => typeof a === "string") || new Set(raw.artifactRefs).size !== raw.artifactRefs.length) fail("SPEC_MALFORMED", `invalid task ${raw.id}`);
		embeddedBytes += checkEmbedded(raw.title, `task ${raw.id} title`, MAX_TITLE_BYTES) + checkEmbedded(raw.description, `task ${raw.id} description`, MAX_DESCRIPTION_BYTES);
	}
	for (const task of tasks) for (const dependency of task.depends as string[]) if (!taskIds.has(dependency) || dependency === task.id) fail("SPEC_MALFORMED", `invalid dependency ${dependency} on task ${task.id}`);
	const visiting = new Set<string>(), visited = new Set<string>(), byId = new Map(tasks.map((task) => [task.id as string, task]));
	const visit = (id: string): void => { if (visiting.has(id)) fail("SPEC_MALFORMED", "task dependency graph contains a cycle"); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id)!.depends as string[]) visit(dep); visiting.delete(id); visited.add(id); };
	for (const id of taskIds) visit(id);

	requireArray(parsed.artifacts, "artifacts"); if (parsed.artifacts.length > 1024) fail("SPEC_MALFORMED", "artifacts exceeds 1024 entries");
	const artifactIds = new Set<string>(); const artifacts = parsed.artifacts as Record<string, unknown>[];
	for (const raw of artifacts) {
		exactKeys(raw, ["id", "path", "sha256", "bytes", "purpose", "mediaType"], "artifact");
		for (const key of ["id", "path", "sha256", "bytes", "purpose"]) if (!(key in raw)) fail("SPEC_MALFORMED", `artifact requires ${key}`);
		requireString(raw.id, "artifact.id"); requireString(raw.path, "artifact.path", true); requireString(raw.sha256, "artifact.sha256"); requireString(raw.purpose, "artifact.purpose", true);
		if (!ARTIFACT_ID.test(raw.id) || artifactIds.has(raw.id)) fail("SPEC_MALFORMED", `invalid or duplicate artifact id "${raw.id}"`); artifactIds.add(raw.id);
		if (raw.path.includes("\0") || !path.isAbsolute(raw.path) || utf8Bytes(raw.path) > MAX_ARTIFACT_PATH_BYTES || !HASH.test(raw.sha256) || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0 || !(raw.mediaType === undefined || (typeof raw.mediaType === "string" && raw.mediaType.length > 0))) fail("SPEC_MALFORMED", `invalid artifact ${raw.id}`);
		embeddedBytes += checkEmbedded(raw.purpose, `artifact ${raw.id} purpose`, MAX_DESCRIPTION_BYTES);
	}
	if (embeddedBytes > MAX_EMBEDDED_BYTES) fail("SPEC_TOO_LARGE", `embedded contract is ${embeddedBytes} bytes; limit is ${MAX_EMBEDDED_BYTES}; use artifact references`);
	for (const task of tasks) for (const artifact of task.artifactRefs as string[]) if (!artifactIds.has(artifact)) fail("SPEC_MALFORMED", `unknown artifact reference ${artifact}`);
	return parsed as unknown as FileSpec;
}

export function prepareSpec(specFile: string, expectedHash: string, cwd: string): PreparedSpec {
	if (!HASH.test(expectedHash)) fail("SPEC_HASH_MISMATCH", "specSha256 must be 64 lowercase hex characters");
	if (typeof specFile !== "string" || specFile.length === 0 || specFile.includes("\0")) fail("SPEC_MALFORMED", "invalid spec path");
	const source = path.resolve(cwd, specFile); const raw = stableReadFile(source, "SPEC_UNSTABLE", MAX_SPEC_BYTES);
	if (sha256(raw) !== expectedHash) fail("SPEC_HASH_MISMATCH", "source bytes do not match specSha256");
	if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) fail("SPEC_MALFORMED", "UTF-8 BOM is forbidden");
	let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { fail("SPEC_MALFORMED", "invalid UTF-8"); }
	const spec = validateSpec(parseJsonNoDuplicateKeys(text));
	for (const artifact of spec.artifacts) {
		let actual: { bytes: number; sha256: string }; try { actual = stableHashFile(artifact.path, "ARTIFACT_UNSTABLE"); } catch (error) { if ((error as Error).message.startsWith("ARTIFACT_")) throw error; fail("ARTIFACT_INVALID", (error as Error).message); }
		if (actual.bytes !== artifact.bytes) fail("ARTIFACT_SIZE_MISMATCH", `${artifact.id}: ${actual.bytes} != ${artifact.bytes}`);
		if (actual.sha256 !== artifact.sha256) fail("ARTIFACT_HASH_MISMATCH", artifact.id);
	}
	return { spec, raw, sha256: expectedHash };
}

export function chunkRanges(raw: Buffer): Array<[number, number]> {
	const ranges: Array<[number, number]> = []; let start = 0;
	while (start < raw.length) { let end = Math.min(start + SPEC_CHUNK_BYTES, raw.length); while (end < raw.length && (raw[end] & 0xc0) === 0x80) end--; if (end <= start) throw new Error("validated UTF-8 chunk made no progress"); ranges.push([start, end]); start = end; }
	return ranges;
}

function attestationPath(squad: Squad, task: Task): string {
	return path.join(path.dirname(path.dirname(squad.spec!.path)), task.id, "spec-read-attestation.json");
}
function artifactsStillMatch(spec: FileSpec): boolean {
	try { return spec.artifacts.every((artifact) => { const actual = stableHashFile(artifact.path, "ARTIFACT_UNSTABLE"); return actual.bytes === artifact.bytes && actual.sha256 === artifact.sha256; }); }
	catch { return false; }
}
function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort(); return keys.length === expected.length && [...expected].sort().every((key, index) => key === keys[index]);
}
function isRfc3339(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function canonicalMetadataMatches(squad: Squad, raw: Buffer): boolean {
	return Boolean(squad.spec && squad.spec.schemaVersion === 1 && HASH.test(squad.spec.sha256) && squad.spec.chunkBytes === SPEC_CHUNK_BYTES && squad.spec.bytes === raw.length && squad.spec.chunkCount === chunkRanges(raw).length && sha256(raw) === squad.spec.sha256);
}
export function validateCanonicalSpec(squad: Squad): boolean {
	if (!squad.spec) return true;
	try { return canonicalMetadataMatches(squad, stableReadFile(squad.spec.path, "SPEC_UNSTABLE")); }
	catch { return false; }
}

export function validateTaskSpecAttestation(squad: Squad, task: Task, options: { verifyArtifacts?: boolean } = {}): boolean {
	if (!squad.spec) return true;
	if (explainTaskSpecAttestationFailure(squad, task) !== null) return false;
	if (options.verifyArtifacts !== false) {
		try {
			const raw = stableReadFile(squad.spec.path, "SPEC_UNSTABLE");
			const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
			if (!artifactsStillMatch(validateSpec(parseJsonNoDuplicateKeys(decoded)))) return false;
		} catch { return false; }
	}
	return true;
}

/**
 * Explain exactly why a task's spec-read attestation is invalid, or null when
 * it is valid. Deliberately EXCLUDES artifact drift: attestation proves the
 * child fully read the canonical spec bytes; drift of pinned artifacts is a
 * separate review-time concern reported by specArtifactDrift(). Precise
 * reasons prevent misdirected retry loops (an agent told to "re-read chunks"
 * when the actual problem was artifact drift re-reads forever).
 */
export function explainTaskSpecAttestationFailure(squad: Squad, task: Task): string | null {
	if (!squad.spec) return null;
	let raw: Buffer;
	try {
		raw = stableReadFile(squad.spec.path, "SPEC_UNSTABLE");
	} catch (error) {
		return `canonical spec file unreadable: ${(error as Error).message}`;
	}
	if (!canonicalMetadataMatches(squad, raw)) {
		return "canonical spec file no longer matches its published sha256/bytes metadata";
	}
	const filePath = attestationPath(squad, task);
	let attestationRaw: Buffer;
	try {
		attestationRaw = stableReadFile(filePath, "SPEC_UNSTABLE");
	} catch {
		return `attestation file missing (${filePath}) — the task's agent must read every canonical spec chunk with squad_spec_read`;
	}
	try {
		const attestationText = new TextDecoder("utf-8", { fatal: true }).decode(attestationRaw);
		const attestation = parseJsonNoDuplicateKeys(attestationText) as Record<string, unknown>;
		const topKeys = ["version", "state", "squadId", "taskId", "specSha256", "specBytes", "chunkBytes", "chunkCount", "chunks", "completedAt"];
		if (!attestation || typeof attestation !== "object" || !exactObjectKeys(attestation, topKeys)) {
			return "attestation file is malformed (unexpected structure/keys)";
		}
		if (attestation.state !== "complete") return `attestation is incomplete (state=${String(attestation.state)}) — continue squad_spec_read until every chunk is delivered`;
		const ranges = chunkRanges(raw); const chunks = attestation.chunks;
		if (attestation.version !== 1 || attestation.squadId !== squad.id || attestation.taskId !== task.id || !isRfc3339(attestation.completedAt)) {
			return "attestation identity fields do not match this squad/task";
		}
		if (attestation.specSha256 !== squad.spec.sha256 || attestation.specBytes !== raw.length || attestation.chunkBytes !== SPEC_CHUNK_BYTES || attestation.chunkCount !== ranges.length) {
			return "attestation was recorded against a different spec revision — re-read every chunk with squad_spec_read";
		}
		if (!Array.isArray(chunks) || chunks.length !== ranges.length) {
			return `attestation chunk list is incomplete (${Array.isArray(chunks) ? chunks.length : 0}/${ranges.length})`;
		}
		for (let index = 0; index < chunks.length; index++) {
			const rawChunk = chunks[index];
			if (!rawChunk || typeof rawChunk !== "object" || Array.isArray(rawChunk)) return `attestation chunk ${index} is malformed`;
			const chunk = rawChunk as Record<string, unknown>; const [start, end] = ranges[index];
			const ok = exactObjectKeys(chunk, ["index", "startByte", "endByteExclusive", "bytes", "sha256", "toolCallId", "deliveredAt"]) && chunk.index === index && chunk.startByte === start && chunk.endByteExclusive === end && chunk.bytes === end - start && chunk.sha256 === sha256(raw.subarray(start, end)) && typeof chunk.toolCallId === "string" && chunk.toolCallId.length > 0 && isRfc3339(chunk.deliveredAt);
			if (!ok) return `attestation chunk ${index} does not match the canonical spec bytes`;
		}
		return null;
	} catch (error) {
		return `attestation file unreadable: ${(error as Error).message}`;
	}
}

/**
 * Describe pinned spec artifacts that changed after spec publication.
 * Empty when everything still matches (or there is no spec). Drift does not
 * block completion; it is surfaced prominently at independent review so the
 * orchestrator verifies each change is a legitimate product of the work.
 */
export function specArtifactDrift(squad: Squad): string[] {
	if (!squad.spec) return [];
	try {
		const raw = stableReadFile(squad.spec.path, "SPEC_UNSTABLE");
		const spec = validateSpec(parseJsonNoDuplicateKeys(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
		const drift: string[] = [];
		for (const artifact of spec.artifacts) {
			try {
				const actual = stableHashFile(artifact.path, "ARTIFACT_UNSTABLE");
				if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) {
					drift.push(`${artifact.path} — modified after spec publication (bytes ${artifact.bytes}→${actual.bytes}, sha256 ${artifact.sha256.slice(0, 12)}…→${actual.sha256.slice(0, 12)}…)`);
				}
			} catch {
				drift.push(`${artifact.path} — missing or unreadable (was ${artifact.bytes} bytes)`);
			}
		}
		return drift;
	} catch {
		return [];
	}
}

function withFileLock<T>(filePath: string, operation: () => T): T {
	fs.mkdirSync(path.dirname(filePath), { recursive: true }); const lock = `${filePath}.lock`; const started = Date.now(); let fd: number | undefined;
	while (fd === undefined) { try { fd = fs.openSync(lock, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.unlinkSync(lock); continue; } } catch { continue; } if (Date.now() - started > 10_000) throw new Error(`Timed out acquiring ${lock}`); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); } }
	try { return operation(); } finally { try { fs.closeSync(fd); } catch { /* ignore */ } try { fs.unlinkSync(lock); } catch { /* ignore */ } }
}
function writeJsonDurable(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 }); const temporary = `${filePath}.tmp.${process.pid}.${randomUUID()}`; const fd = fs.openSync(temporary, "wx", 0o600);
	try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	fs.renameSync(temporary, filePath);
	try { const dirFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); } } catch { /* directory fsync unavailable */ }
}

function archiveInvalidProgress(statePath: string): void {
	if (!fs.existsSync(statePath)) return;
	const archived = `${statePath}.invalid.${Date.now()}.${randomUUID()}`;
	try { fs.renameSync(statePath, archived); }
	catch { try { fs.unlinkSync(statePath); } catch { /* fail-closed caller will keep the guard shut */ } }
}

function loadValidProgress(statePath: string, manifest: { squadId: string; taskId: string; sha256: string; bytes: number }, raw: Buffer): { state: "required" | "reading" | "complete"; records: ChunkRecord[] } {
	if (!fs.existsSync(statePath)) return { state: "required", records: [] };
	try {
		const stateRaw = stableReadFile(statePath, "SPEC_UNSTABLE");
		const stateText = new TextDecoder("utf-8", { fatal: true }).decode(stateRaw);
		const state = parseJsonNoDuplicateKeys(stateText) as Record<string, unknown>;
		const ranges = chunkRanges(raw);
		const keys = ["version", "state", "squadId", "taskId", "specSha256", "specBytes", "chunkBytes", "chunkCount", "chunks"];
		if (!state || typeof state !== "object" || !exactObjectKeys(state, keys) || state.version !== 1 || !["reading", "complete"].includes(String(state.state)) || state.squadId !== manifest.squadId || state.taskId !== manifest.taskId || state.specSha256 !== manifest.sha256 || state.specBytes !== manifest.bytes || state.chunkBytes !== SPEC_CHUNK_BYTES || state.chunkCount !== ranges.length || !Array.isArray(state.chunks) || state.chunks.length > ranges.length) throw new Error("invalid progress identity");
		const seen = new Set<number>();
		const records = state.chunks.map((rawRecord) => {
			if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) throw new Error("invalid progress chunk");
			const record = rawRecord as Record<string, unknown>;
			if (!exactObjectKeys(record, ["index", "startByte", "endByteExclusive", "bytes", "sha256", "toolCallId", "deliveredAt"]) || !Number.isInteger(record.index) || seen.has(record.index as number)) throw new Error("invalid progress chunk identity");
			const index = record.index as number; const range = ranges[index];
			if (!range || record.startByte !== range[0] || record.endByteExclusive !== range[1] || record.bytes !== range[1] - range[0] || record.sha256 !== sha256(raw.subarray(range[0], range[1])) || typeof record.toolCallId !== "string" || record.toolCallId.length === 0 || !isRfc3339(record.deliveredAt)) throw new Error("invalid progress chunk metadata");
			seen.add(index); return record as unknown as ChunkRecord;
		});
		records.sort((a, b) => a.index - b.index);
		if (state.state === "complete" && records.length !== ranges.length) throw new Error("invalid progress state");
		return { state: state.state as "reading" | "complete", records };
	} catch {
		archiveInvalidProgress(statePath);
		return { state: "required", records: [] };
	}
}

function completeAttestationValue(manifest: { squadId: string; taskId: string; sha256: string; bytes: number }, raw: Buffer, records: ChunkRecord[]): Record<string, unknown> {
	return { version: 1, state: "complete", squadId: manifest.squadId, taskId: manifest.taskId, specSha256: manifest.sha256, specBytes: manifest.bytes, chunkBytes: SPEC_CHUNK_BYTES, chunkCount: chunkRanges(raw).length, chunks: records, completedAt: new Date().toISOString() };
}

function registerInvalidManifestGuard(pi: ExtensionAPI, reason: string): void {
	pi.on("tool_call", () => ({ block: true, reason: `Invalid file-spec child manifest: ${reason}. All tools are blocked.` }));
	pi.on("before_agent_start", (event: { systemPrompt: string }) => ({ systemPrompt: `${event.systemPrompt}\n\nFile-spec bootstrap failed closed: ${reason}. No tool or task completion is authorized.` }));
}

export function registerChildSpecReader(pi: ExtensionAPI): boolean {
	const env = process.env;
	if (env.PI_SQUAD_CHILD !== "1") return false;
	const specKeys = ["PI_SQUAD_SPEC_PATH", "PI_SQUAD_SPEC_SHA256", "PI_SQUAD_SPEC_BYTES", "PI_SQUAD_SPEC_CHUNK_BYTES"] as const;
	const hasSpecManifest = specKeys.some((key) => env[key] !== undefined);
	if (!hasSpecManifest) return false;
	const required = [env.PI_SQUAD_ID, env.PI_SQUAD_TASK_ID, ...specKeys.map((key) => env[key])];
	const bytesText = env.PI_SQUAD_SPEC_BYTES ?? ""; const bytes = Number(bytesText);
	const invalidReason = required.some((value) => !value)
		? "required environment fields are missing"
		: !isFileSpecTaskId(env.PI_SQUAD_TASK_ID!) || !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(env.PI_SQUAD_ID!)
			? "squad or task identity is unsafe"
			: !path.isAbsolute(env.PI_SQUAD_SPEC_PATH!) || env.PI_SQUAD_SPEC_PATH!.includes("\0")
				? "canonical path is not an absolute native path"
				: path.basename(env.PI_SQUAD_SPEC_PATH!) !== "spec.v1.json" || path.basename(path.dirname(env.PI_SQUAD_SPEC_PATH!)) !== "spec" || path.basename(path.dirname(path.dirname(env.PI_SQUAD_SPEC_PATH!))) !== env.PI_SQUAD_ID
					? "canonical path does not match the squad manifest layout"
					: !HASH.test(env.PI_SQUAD_SPEC_SHA256!) || env.PI_SQUAD_SPEC_CHUNK_BYTES !== String(SPEC_CHUNK_BYTES) || !/^\d+$/.test(bytesText) || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_SPEC_BYTES
						? "hash, byte length, or chunk size is invalid"
						: null;
	if (invalidReason) { registerInvalidManifestGuard(pi, invalidReason); return true; }
	const manifest = { squadId: env.PI_SQUAD_ID!, taskId: env.PI_SQUAD_TASK_ID!, path: env.PI_SQUAD_SPEC_PATH!, sha256: env.PI_SQUAD_SPEC_SHA256!, bytes };
	const taskDir = path.join(path.dirname(path.dirname(manifest.path)), manifest.taskId); const statePath = path.join(taskDir, "spec-read-state.json");
	const squad = (): Squad => { const raw = stableReadFile(manifest.path, "SPEC_UNSTABLE"); return { id: manifest.squadId, spec: { schemaVersion: 1, sha256: manifest.sha256, bytes: manifest.bytes, path: manifest.path, chunkBytes: SPEC_CHUNK_BYTES, chunkCount: chunkRanges(raw).length } } as Squad; };
	const task = { id: manifest.taskId } as Task; const pending = new Map<string, { metadata: ChunkMetadata; text: string }>();
	const complete = (): boolean => {
		const currentSquad = squad();
		if (validateTaskSpecAttestation(currentSquad, task, { verifyArtifacts: false })) return true;
		const raw = stableReadFile(manifest.path, "SPEC_UNSTABLE");
		if (raw.length !== manifest.bytes || sha256(raw) !== manifest.sha256) return false;
		return withFileLock(statePath, () => {
			const progress = loadValidProgress(statePath, manifest, raw);
			const attestation = attestationPath(currentSquad, task);
			if (progress.state !== "reading" || progress.records.length !== chunkRanges(raw).length || fs.existsSync(attestation)) return false;
			writeJsonDurable(attestation, completeAttestationValue(manifest, raw, progress.records));
			writeJsonDurable(statePath, { version: 1, state: "complete", squadId: manifest.squadId, taskId: manifest.taskId, specSha256: manifest.sha256, specBytes: manifest.bytes, chunkBytes: SPEC_CHUNK_BYTES, chunkCount: chunkRanges(raw).length, chunks: progress.records });
			return validateTaskSpecAttestation(currentSquad, task, { verifyArtifacts: false });
		});
	};
	const missingIndices = (): number[] => {
		const raw = stableReadFile(manifest.path, "SPEC_UNSTABLE");
		if (raw.length !== manifest.bytes || sha256(raw) !== manifest.sha256) return chunkRanges(raw).map((_, index) => index);
		const count = chunkRanges(raw).length; const progress = loadValidProgress(statePath, manifest, raw);
		if (progress.state === "complete" && !validateTaskSpecAttestation(squad(), task, { verifyArtifacts: false })) {
			archiveInvalidProgress(attestationPath(squad(), task)); archiveInvalidProgress(statePath);
			return Array.from({ length: count }, (_, index) => index);
		}
		const delivered = new Set(progress.records.map((chunk) => chunk.index));
		return Array.from({ length: count }, (_, index) => index).filter((index) => !delivered.has(index));
	};

	pi.on("tool_call", (event: { toolName: string }) => {
		try { if (event.toolName !== "squad_spec_read" && !complete()) return { block: true, reason: "Read every canonical squad spec chunk with squad_spec_read before using other tools." }; }
		catch { if (event.toolName !== "squad_spec_read") return { block: true, reason: "Canonical squad spec state is invalid; all normal tools are blocked." }; }
	});
	pi.on("before_agent_start", (event: { systemPrompt: string }) => {
		let missing: number[]; let bootstrapError: string | null = null;
		try { missing = complete() ? [] : missingIndices(); }
		catch (error) { missing = []; bootstrapError = (error as Error).message; }
		const bootstrap = [
			"You are a file-spec squad child. Nested squad orchestration is unavailable.",
			`Squad ID: ${manifest.squadId}`,
			`Task ID: ${manifest.taskId}`,
			`Canonical spec SHA-256: ${manifest.sha256}`,
			`Canonical spec bytes: ${manifest.bytes}`,
			`Chunk bytes: ${SPEC_CHUNK_BYTES}`,
			`Missing chunk indices: [${missing.join(",")}]`,
			...(bootstrapError ? [`Canonical bootstrap error: ${bootstrapError}`, "All normal tools remain blocked until canonical integrity is restored."] : ["Before any normal tool can run, call squad_spec_read for every missing chunk index. Exact tool-result delivery is durably attested."]),
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${bootstrap}` };
	});
	pi.on("message_end", (event: ExtensionEvent) => {
		if (event.type !== "message_end") return;
		const message = event.message;
		if (message.role !== "toolResult" || message.toolName !== "squad_spec_read" || message.isError) return;
		const candidate = pending.get(message.toolCallId); if (!candidate) return; pending.delete(message.toolCallId);
		if (message.content.length !== 2 || message.content[0]?.type !== "text" || message.content[1]?.type !== "text" || message.content[0].text !== JSON.stringify(candidate.metadata) || message.content[1].text !== candidate.text || JSON.stringify(message.details) !== JSON.stringify(candidate.metadata)) return;
		const raw = stableReadFile(manifest.path, "SPEC_UNSTABLE"); if (raw.length !== manifest.bytes || sha256(raw) !== manifest.sha256) return; const ranges = chunkRanges(raw); const metadata = candidate.metadata; const range = ranges[metadata.index]; if (!range || candidate.text !== new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(range[0], range[1]))) return;
		withFileLock(statePath, () => {
			const currentSquad = squad();
			if (validateTaskSpecAttestation(currentSquad, task, { verifyArtifacts: false })) return;
			const progress = loadValidProgress(statePath, manifest, raw); const records = progress.records;
			const record: ChunkRecord = { index: metadata.index, startByte: metadata.startByte, endByteExclusive: metadata.endByteExclusive, bytes: metadata.chunkBytes, sha256: metadata.chunkSha256, toolCallId: message.toolCallId, deliveredAt: new Date().toISOString() };
			const existing = records.find((entry) => entry.index === record.index);
			if (existing) {
				if (existing.startByte !== record.startByte || existing.endByteExclusive !== record.endByteExclusive || existing.bytes !== record.bytes || existing.sha256 !== record.sha256) {
					writeJsonDurable(statePath, { version: 1, state: "invalid", squadId: manifest.squadId, taskId: manifest.taskId, specSha256: manifest.sha256, specBytes: manifest.bytes, chunkBytes: SPEC_CHUNK_BYTES, chunkCount: ranges.length, chunks: records, conflict: record });
					archiveInvalidProgress(statePath);
					return;
				}
				if (progress.state === "reading" && records.length === ranges.length && !fs.existsSync(attestationPath(currentSquad, task))) {
					writeJsonDurable(attestationPath(currentSquad, task), completeAttestationValue(manifest, raw, records));
					writeJsonDurable(statePath, { version: 1, state: "complete", squadId: manifest.squadId, taskId: manifest.taskId, specSha256: manifest.sha256, specBytes: manifest.bytes, chunkBytes: SPEC_CHUNK_BYTES, chunkCount: ranges.length, chunks: records });
				}
				return;
			}
			records.push(record); records.sort((a, b) => a.index - b.index);
			const full = records.length === ranges.length && records.every((entry, index) => entry.index === index && entry.startByte === ranges[index][0] && entry.endByteExclusive === ranges[index][1] && entry.sha256 === sha256(raw.subarray(ranges[index][0], ranges[index][1])));
			writeJsonDurable(statePath, { version: 1, state: "reading", squadId: manifest.squadId, taskId: manifest.taskId, specSha256: manifest.sha256, specBytes: manifest.bytes, chunkBytes: SPEC_CHUNK_BYTES, chunkCount: ranges.length, chunks: records });
			if (full) {
				writeJsonDurable(attestationPath(currentSquad, task), completeAttestationValue(manifest, raw, records));
				writeJsonDurable(statePath, { version: 1, state: "complete", squadId: manifest.squadId, taskId: manifest.taskId, specSha256: manifest.sha256, specBytes: manifest.bytes, chunkBytes: SPEC_CHUNK_BYTES, chunkCount: ranges.length, chunks: records });
			}
		});
	});

	pi.registerTool({
		name: "squad_spec_read", label: "Read canonical squad spec", description: "Deliver one exact UTF-8-aligned canonical spec chunk. Available only inside a file-spec child.",
		parameters: {
			type: "object", additionalProperties: false, required: ["index"],
			properties: { index: { type: "integer", minimum: 0 } },
		} as TSchema,
		async execute(toolCallId: string, params: { index: number }) {
			const raw = stableReadFile(manifest.path, "SPEC_UNSTABLE"); if (raw.length !== manifest.bytes || sha256(raw) !== manifest.sha256) throw new Error("Canonical spec integrity failure");
			const ranges = chunkRanges(raw); if (!Number.isInteger(params.index) || params.index < 0 || params.index >= ranges.length) throw new Error(`Chunk index ${params.index} out of range 0..${ranges.length - 1}`);
			const [start, end] = ranges[params.index]; const chunk = raw.subarray(start, end); const text = new TextDecoder("utf-8", { fatal: true }).decode(chunk);
			const metadata: ChunkMetadata = { version: 1, squadId: manifest.squadId, taskId: manifest.taskId, index: params.index, chunkCount: ranges.length, startByte: start, endByteExclusive: end, chunkBytes: chunk.length, chunkSha256: sha256(chunk), specBytes: raw.length, specSha256: manifest.sha256 };
			pending.set(toolCallId, { metadata, text });
			return { content: [{ type: "text" as const, text: JSON.stringify(metadata) }, { type: "text" as const, text }], details: metadata };
		},
	});
	return true;
}
