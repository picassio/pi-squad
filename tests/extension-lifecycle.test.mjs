import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-extension-lifecycle-"));
const stubsDir = path.join(tempHome, "stubs");
const binDir = path.join(tempHome, "bin");
fs.mkdirSync(stubsDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });

const typeboxStub = path.join(stubsDir, "typebox.mjs");
const piAiStub = path.join(stubsDir, "pi-ai.mjs");
const piTuiStub = path.join(stubsDir, "pi-tui.mjs");
fs.writeFileSync(typeboxStub, `
export const Type = new Proxy({}, { get: () => (..._args) => ({}) });
`);
fs.writeFileSync(piAiStub, `
export async function completeSimple() { throw new Error("advisor must not run in this test"); }
`);
fs.writeFileSync(piTuiStub, `
export function visibleWidth(value) { return value.replace(/\\x1b\\[[0-9;]*m/g, "").length; }
export function truncateToWidth(value, width, suffix = "") {
	return visibleWidth(value) <= width ? value : value.slice(0, Math.max(0, width - suffix.length)) + suffix;
}
export function matchesKey() { return false; }
`);

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "typebox") return { url: pathToFileURL(typeboxStub).href, shortCircuit: true };
		if (specifier === "@earendil-works/pi-ai") return { url: pathToFileURL(piAiStub).href, shortCircuit: true };
		if (specifier === "@earendil-works/pi-tui") return { url: pathToFileURL(piTuiStub).href, shortCircuit: true };
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try { return nextResolve(specifier, context); }
			catch { return nextResolve(specifier.replace(/\.js$/, ".ts"), context); }
		}
		return nextResolve(specifier, context);
	},
});

const rpcLog = path.join(tempHome, "fake-pi-rpc.jsonl");
const fakePi = path.join(binDir, "pi");
fs.writeFileSync(fakePi, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const log = process.env.PI_SQUAD_FAKE_RPC_LOG;
fs.appendFileSync(log, JSON.stringify({ kind: "argv", args }) + "\\n");
const sessionIndex = args.indexOf("--session");
const dirIndex = args.indexOf("--session-dir");
const sessionFile = sessionIndex >= 0
	? args[sessionIndex + 1]
	: path.join(args[dirIndex + 1], "fresh-session.jsonl");
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString();
	const lines = buffer.split("\\n");
	buffer = lines.pop() || "";
	for (const line of lines) {
		if (!line.trim()) continue;
		const command = JSON.parse(line);
		fs.appendFileSync(log, JSON.stringify({ kind: "rpc", command }) + "\\n");
		const response = { type: "response", id: command.id, command: command.type, success: true };
		if (command.type === "get_state") {
			response.data = { sessionFile, sessionId: "original-session-id" };
		}
		process.stdout.write(JSON.stringify(response) + "\\n");
	}
});
process.on("SIGTERM", () => process.exit(0));
`);
fs.chmodSync(fakePi, 0o755);

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ""}`;
process.env.PI_SQUAD_FAKE_RPC_LOG = rpcLog;
delete process.env.PI_SQUAD_CHILD;

const store = await import("../src/store.ts");
const { default: registerExtension } = await import("../src/index.ts");

function createFakeExtensionApi() {
	const tools = new Map();
	const events = new Map();
	const sent = [];
	return {
		tools,
		events,
		sent,
		registerTool(definition) { tools.set(definition.name, definition); },
		registerCommand() {},
		on(name, listener) {
			const listeners = events.get(name) || [];
			listeners.push(listener);
			events.set(name, listeners);
		},
		sendMessage(message, options) { sent.push({ message, options }); },
		getThinkingLevel() { return "medium"; },
	};
}

async function emit(api, name, ...args) {
	for (const listener of api.events.get(name) || []) await listener(...args);
}

function readRpcLog() {
	return fs.readFileSync(rpcLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("squad_message reconstructs after restart and reopens a done task with --session", async (t) => {
	const squadId = "sq-extension-resume";
	const taskId = "completed-task";
	const originalSession = path.join(store.getTaskSessionDir(squadId, taskId), "original.jsonl");
	store.saveSquad({
		id: squadId,
		goal: "resume a completed task after process restart",
		status: "review",
		created: "2026-07-16T09:00:00.000Z",
		cwd: tempHome,
		agents: { backend: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	});
	store.createTask(squadId, {
		id: taskId,
		title: "Completed task",
		description: "Original durable work",
		agent: "backend",
		status: "done",
		depends: [],
		created: "2026-07-16T09:00:00.000Z",
		started: "2026-07-16T09:00:01.000Z",
		completed: "2026-07-16T09:01:00.000Z",
		output: "original result",
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 1 },
	});
	store.bindTaskSession(squadId, taskId, { file: originalSession, sessionId: "original-session-id" });

	const api = createFakeExtensionApi();
	registerExtension(api);
	const ctx = { hasUI: false, cwd: tempHome };
	await emit(api, "session_start", {}, ctx);
	assert.ok(api.sent.some((entry) => entry.message.customType === "squad-review-required"), "restart restores the review squad as active");

	const payload = "resume this exact task\nΩ-END";
	const tool = api.tools.get("squad_message");
	const result = await tool.execute("call-1", { taskId, message: payload, expectReply: true }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /Message delivered/);

	const task = store.loadTask(squadId, taskId);
	assert.equal(task.status, "in_progress", "resumed/live task stays in_progress");
	assert.equal(task.completed, null);
	assert.equal(store.loadSquad(squadId).status, "running");
	assert.deepEqual(store.loadTaskSession(squadId, taskId), {
		file: originalSession,
		sessionId: "original-session-id",
	});
	assert.equal(store.loadPendingTaskMessages(squadId, taskId).length, 0, "accepted prompt acknowledges durable mail");
	assert.equal(store.loadTaskMailbox(squadId, taskId)[0].message.text, payload, "multiline Unicode payload remains exact");

	const records = readRpcLog();
	const argv = records.find((record) => record.kind === "argv").args;
	assert.deepEqual(argv.slice(0, 4), ["--mode", "rpc", "--session", originalSession]);
	assert.equal(argv.includes("--session-dir"), false, "resumed task must not receive a fresh session directory");
	const commands = records.filter((record) => record.kind === "rpc").map((record) => record.command);
	assert.deepEqual(commands.map((command) => command.type), ["get_state", "prompt"]);
	assert.ok(commands.every((command) => typeof command.id === "string" && command.id.length > 0), "RPC requests are correlated");
	assert.ok(commands[1].message.includes(payload));
	t.diagnostic(`spawn argv: ${JSON.stringify(argv.slice(0, 4))}`);
	t.diagnostic(`RPC commands: ${commands.map((command) => command.type).join(" -> ")}`);

	await emit(api, "session_shutdown");
	assert.equal(store.loadTask(squadId, taskId).status, "suspended", "intentional shutdown must not be misclassified as an unexpected exit");
});

test("extension restart automatically reconstructs and delivers pending task mail", async () => {
	const squadId = "sq-extension-pending-recovery";
	const taskId = "pending-after-crash";
	const originalSession = path.join(store.getTaskSessionDir(squadId, taskId), "original.jsonl");
	store.saveSquad({
		id: squadId,
		goal: "recover mailbox without another user action",
		status: "review",
		created: "2026-07-16T10:00:00.000Z",
		cwd: tempHome,
		agents: { backend: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	});
	store.createTask(squadId, {
		id: taskId,
		title: "Pending recovery",
		description: "Recover the durable request",
		agent: "backend",
		status: "done",
		depends: [],
		created: "2026-07-16T10:00:00.000Z",
		started: "2026-07-16T10:00:01.000Z",
		completed: "2026-07-16T10:01:00.000Z",
		output: "old result",
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 1 },
	});
	store.bindTaskSession(squadId, taskId, { file: originalSession, sessionId: "original-session-id" });
	const pendingText = `PENDING-BEFORE-RESTART\n${"full-line\n".repeat(500)}PENDING-END`;
	store.queueTaskMessage(squadId, taskId, {
		id: "pending-restart-mail",
		ts: store.now(),
		from: "orchestrator",
		type: "message",
		text: pendingText,
		expectsReply: true,
	});
	const rpcBefore = readRpcLog().length;

	const api = createFakeExtensionApi();
	registerExtension(api);
	const ctx = { hasUI: false, cwd: tempHome };
	await emit(api, "session_start", {}, ctx);

	const records = readRpcLog().slice(rpcBefore);
	const argv = records.find((record) => record.kind === "argv")?.args;
	assert.deepEqual(argv?.slice(0, 4), ["--mode", "rpc", "--session", originalSession], "restart resumes the exact task session automatically");
	const prompt = records.find((record) => record.kind === "rpc" && record.command.type === "prompt")?.command.message;
	assert.ok(prompt?.includes(pendingText), "automatic recovery delivers the complete pending payload");
	assert.equal(store.loadPendingTaskMessages(squadId, taskId).length, 0, "accepted recovery prompt acknowledges the mailbox");
	assert.equal(store.loadTask(squadId, taskId).status, "in_progress");
	assert.equal(store.loadSquad(squadId).status, "running");

	await emit(api, "session_shutdown");
});
