import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-master-switch-"));
const stubsDir = path.join(tempHome, "stubs");
const binDir = path.join(tempHome, "bin");
fs.mkdirSync(stubsDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
const typeboxStub = path.join(stubsDir, "typebox.mjs");
const piAiStub = path.join(stubsDir, "pi-ai.mjs");
const piTuiStub = path.join(stubsDir, "pi-tui.mjs");
fs.writeFileSync(typeboxStub, `export const Type = new Proxy({}, { get: () => (..._args) => ({}) });\n`);
fs.writeFileSync(piAiStub, `export async function completeSimple() { throw new Error("advisor must not run"); }\n`);
fs.writeFileSync(piTuiStub, `
export function visibleWidth(value) { return value.replace(/\\x1b\\[[0-9;]*m/g, "").length; }
export function truncateToWidth(value, width, suffix = "") { return visibleWidth(value) <= width ? value : value.slice(0, Math.max(0, width - suffix.length)) + suffix; }
export function matchesKey(data, key) { return data === key; }
`);
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "typebox") return { url: pathToFileURL(typeboxStub).href, shortCircuit: true };
		if (specifier === "@earendil-works/pi-ai" || specifier === "@earendil-works/pi-ai/compat") return { url: pathToFileURL(piAiStub).href, shortCircuit: true };
		if (specifier === "@earendil-works/pi-tui") return { url: pathToFileURL(piTuiStub).href, shortCircuit: true };
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try { return nextResolve(specifier, context); }
			catch { return nextResolve(specifier.replace(/\.js$/, ".ts"), context); }
		}
		return nextResolve(specifier, context);
	},
});

const rpcLog = path.join(tempHome, "rpc.jsonl");
const fakePi = path.join(binDir, "pi");
fs.writeFileSync(fakePi, `#!/usr/bin/env node
const fs = require("node:fs"); const path = require("node:path");
const args = process.argv.slice(2); fs.appendFileSync(process.env.PI_SQUAD_FAKE_RPC_LOG, JSON.stringify({kind:"argv",args})+"\\n");
const sessionIndex=args.indexOf("--session"), dirIndex=args.indexOf("--session-dir");
const sessionFile=sessionIndex>=0?args[sessionIndex+1]:path.join(args[dirIndex+1],"session.jsonl"); fs.mkdirSync(path.dirname(sessionFile),{recursive:true}); if(!fs.existsSync(sessionFile))fs.writeFileSync(sessionFile,"");
let buffer=""; process.stdin.on("data", chunk=>{ buffer+=chunk; const lines=buffer.split("\\n"); buffer=lines.pop()||""; for(const line of lines){ if(!line.trim())continue; const command=JSON.parse(line); fs.appendFileSync(process.env.PI_SQUAD_FAKE_RPC_LOG,JSON.stringify({kind:"rpc",command})+"\\n"); const response={type:"response",id:command.id,command:command.type,success:true}; if(command.type==="get_state")response.data={sessionFile,sessionId:"master-switch-session"}; process.stdout.write(JSON.stringify(response)+"\\n"); }});
process.on("SIGTERM",()=>{ fs.appendFileSync(process.env.PI_SQUAD_FAKE_RPC_LOG,JSON.stringify({kind:"signal",signal:"SIGTERM"})+"\\n"); process.exit(0); });
`);
fs.chmodSync(fakePi, 0o755);
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ""}`;
process.env.PI_SQUAD_FAKE_RPC_LOG = rpcLog;
delete process.env.PI_SQUAD_CHILD;

const store = await import("../src/store.ts");
const { default: registerExtension } = await import("../src/index.ts");

function createApi() {
	const tools = new Map(), commands = new Map(), events = new Map(), sent = [];
	return {
		tools, commands, events, sent,
		registerTool(def) { tools.set(def.name, def); },
		registerCommand(name, def) { commands.set(name, def); },
		on(name, listener) { const listeners = events.get(name) || []; listeners.push(listener); events.set(name, listeners); },
		sendMessage(message, options) { sent.push({ message, options }); },
		getThinkingLevel() { return "medium"; },
	};
}
async function emit(api, name, ...args) { for (const listener of api.events.get(name) || []) await listener(...args); }
function rpcRecords() { return fs.existsSync(rpcLog) ? fs.readFileSync(rpcLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []; }
function task(id, status, depends = []) {
	return { id, title: id, description: id, agent: "backend", status, depends, created: store.now(), started: status === "in_progress" ? store.now() : null, completed: null, output: null, error: null, usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 } };
}
function squad(id, status = "paused", extra = {}) {
	return { id, goal: id, status, created: store.now(), cwd: tempHome, agents: { backend: {} }, config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 }, ...extra };
}
function makeUi() {
	const notifications = [], widgetValues = [], statusValues = [], terminalHandlers = [];
	let panel;
	const theme = { fg: (_color, text) => text, bold: (text) => text };
	const tui = { terminal: { rows: 40, columns: 160 }, requestRender() {} };
	const ui = {
		theme,
		notifications,
		widgetValues,
		statusValues,
		notify(message, level) { notifications.push({ message, level }); },
		setWidget(_id, value) { widgetValues.push(value); },
		setStatus(_id, value) { statusValues.push(value); },
		onTerminalInput(handler) { terminalHandlers.push(handler); },
		select: async () => { throw new Error("disabled command reached selector"); },
		input: async () => { throw new Error("disabled command reached input"); },
		custom(factory) { return new Promise((resolve) => { panel = factory(tui, theme, {}, resolve); }); },
	};
	return { ui, notifications, widgetValues, statusValues, terminalHandlers, get panel() { return panel; } };
}

let disabledApi;
let disabledCtx;
let disabledUiState;
const disabledSquadId = "master-disabled-running";
const reviewSquadId = "master-disabled-review";

test("settings default enabled and validate legacy or malformed enabled values", () => {
	assert.equal(store.loadSquadSettings().enabled, true);
	fs.mkdirSync(path.dirname(store.getSquadSettingsPath()), { recursive: true });
	fs.writeFileSync(store.getSquadSettingsPath(), JSON.stringify({ defaultModel: "legacy-model", enabled: "no" }));
	const legacy = store.loadSquadSettings();
	assert.equal(legacy.enabled, true);
	assert.equal(legacy.defaultModel, "legacy-model");
	const settings = { ...legacy, enabled: false, defaultThinking: "high", advisor: { ...legacy.advisor, maxCallsPerTask: 7 } };
	store.saveSquadSettings(settings);
	assert.deepEqual(store.loadSquadSettings(), settings);
});

test("disabled startup is read-only and retains authoritative safety reminders", async () => {
	store.saveSquad(squad(disabledSquadId, "running"));
	store.createTask(disabledSquadId, task("orphan-in-progress", "in_progress"));
	store.queueTaskMessage(disabledSquadId, "orphan-in-progress", { ts: store.now(), from: "orchestrator", type: "message", text: "pending exact mail" });
	const attention = { kind: "suspended_stall", fingerprint: "exact-fingerprint", suspendedTaskIds: ["suspended-exact"], blockedTaskIds: ["blocked-exact"], detectedAt: store.now(), delivery: "delivered", deliveredAt: store.now() };
	store.saveSquad(squad(reviewSquadId, "review", {
		review: { status: "pending", requestedAt: store.now(), completedAt: null, verdict: null, contractChecks: [], diffReview: "", verificationEvidence: [], integrationEvidence: "", issues: [] },
		suspendedStallAttention: attention,
	}));
	store.createTask(reviewSquadId, { ...task("reviewed-work", "done"), completed: store.now(), output: "candidate" });
	const beforeTask = fs.readFileSync(store.getTaskFilePath(disabledSquadId, "orphan-in-progress"), "utf8");
	const beforeSquad = fs.readFileSync(store.getSquadFilePath(disabledSquadId), "utf8");
	const beforeMail = fs.readFileSync(store.getTaskMailboxFilePath(disabledSquadId, "orphan-in-progress"), "utf8");
	disabledUiState = makeUi();
	disabledCtx = { hasUI: true, cwd: tempHome, ui: disabledUiState.ui, sessionManager: { getSessionFile: () => null } };
	disabledApi = createApi(); registerExtension(disabledApi);
	await emit(disabledApi, "session_start", {}, disabledCtx);
	assert.equal(rpcRecords().length, 0, "disabled startup creates no child or scheduler work");
	assert.equal(disabledApi.sent.length, 0, "disabled startup emits no operational notification");
	assert.equal(disabledUiState.terminalHandlers.length, 1, "disabled startup registers only a fail-closed Ctrl+Q gate");
	const ctrlQ = disabledUiState.terminalHandlers[0]("\x11");
	assert.deepEqual(ctrlQ, { consume: true });
	assert.match(disabledUiState.notifications.at(-1).message, /pi-squad is disabled.*\/squad enable/i);
	assert.equal(disabledUiState.widgetValues.length, 0, "disabled startup does not install widget content");
	assert.equal(fs.readFileSync(store.getTaskFilePath(disabledSquadId, "orphan-in-progress"), "utf8"), beforeTask);
	assert.equal(fs.readFileSync(store.getSquadFilePath(disabledSquadId), "utf8"), beforeSquad);
	assert.equal(fs.readFileSync(store.getTaskMailboxFilePath(disabledSquadId, "orphan-in-progress"), "utf8"), beforeMail);
	const hook = disabledApi.events.get("before_agent_start")[0];
	const injected = await hook({ systemPrompt: "BASE" }, disabledCtx);
	assert.match(injected.systemPrompt, /ORCHESTRATOR REVIEW IS MANDATORY/);
	assert.match(injected.systemPrompt, /suspended-exact/);
	assert.match(injected.systemPrompt, /blocked-exact/);
	assert.match(injected.systemPrompt, /No task was resumed automatically/);
	assert.match(injected.systemPrompt, /Run \/squad enable first/);
	assert.deepEqual(store.loadSquad(reviewSquadId).suspendedStallAttention, attention);
});

test("all five tools and every slash branch fail closed before lookup or mutation", async () => {
	const rootBefore = fs.readFileSync(store.getTaskFilePath(disabledSquadId, "orphan-in-progress"), "utf8");
	const calls = {
		squad: { goal: "must not plan" },
		squad_status: { squadId: disabledSquadId },
		squad_review: { squadId: reviewSquadId, verdict: "pass", contractChecks: ["x"], diffReview: "x", verificationEvidence: ["x"], integrationEvidence: "x", issues: [] },
		squad_message: { taskId: "orphan-in-progress", message: "must not queue" },
		squad_modify: { action: "resume_task", squadId: disabledSquadId, taskId: "orphan-in-progress" },
	};
	assert.deepEqual([...disabledApi.tools.keys()].sort(), Object.keys(calls).sort());
	for (const [name, params] of Object.entries(calls)) {
		const result = await disabledApi.tools.get(name).execute(name, params, undefined, undefined, disabledCtx);
		assert.match(result.content[0].text, /pi-squad is disabled.*\/squad enable.*no squad work was changed/i, name);
	}
	const command = disabledApi.commands.get("squad");
	const forms = ["", "select", "list", "all", disabledSquadId, "resume", `resume ${disabledSquadId}`, "msg orphan-in-progress no", "widget", "panel", "clear", "cancel", "cleanup", "cleanup all", "agents", "defaults", "advisor", "unknown", "enable extra", "disable extra"];
	for (const form of forms) {
		const before = disabledUiState.notifications.length;
		await command.handler(form, disabledCtx);
		assert.equal(disabledUiState.notifications.length, before + 1, `one disabled notice for /squad ${form}`);
		assert.match(disabledUiState.notifications.at(-1).message, /pi-squad is disabled.*\/squad enable.*no squad work was changed/i);
	}
	assert.equal(rpcRecords().length, 0);
	assert.equal(fs.readFileSync(store.getTaskFilePath(disabledSquadId, "orphan-in-progress"), "utf8"), rootBefore);
	assert.equal(store.loadSquadSettings().enabled, false);
	await command.handler("disable", disabledCtx);
	assert.equal(store.loadTask(disabledSquadId, "orphan-in-progress").status, "in_progress", "idempotent disable does not rewrite work");
});

test("enable is persistent and idempotent without selecting, reconstructing, or resuming", async () => {
	const command = disabledApi.commands.get("squad");
	const beforeRpc = rpcRecords().length;
	await command.handler("enable", disabledCtx);
	let settings = store.loadSquadSettings();
	assert.equal(settings.enabled, true);
	assert.equal(settings.defaultModel, "legacy-model");
	assert.equal(settings.defaultThinking, "high");
	assert.equal(settings.advisor.maxCallsPerTask, 7);
	assert.equal(store.loadTask(disabledSquadId, "orphan-in-progress").status, "in_progress", "enable performs no startup recovery or status normalization");
	assert.equal(store.loadTask(reviewSquadId, "reviewed-work").status, "done");
	assert.equal(rpcRecords().length, beforeRpc);
	await command.handler("enable", disabledCtx);
	assert.equal(rpcRecords().length, beforeRpc, "repeated enable does not spawn or resume");
	assert.equal(store.loadSquadSettings().enabled, true);
});

test("repeated enable preserves an explicitly focused squad and widget", async () => {
	const focusedId = "master-focused-enable";
	store.saveSquad(squad(focusedId, "done"));
	store.createTask(focusedId, { ...task("focused-done", "done"), completed: store.now(), output: "complete" });
	const command = disabledApi.commands.get("squad");
	await command.handler(focusedId, disabledCtx);
	assert.equal(typeof disabledUiState.widgetValues.at(-1), "function");
	assert.match(disabledUiState.statusValues.at(-1), /✓ squad 1\/1/);
	await command.handler("enable", disabledCtx);
	await new Promise((resolve) => setTimeout(resolve, 75));
	assert.equal(typeof disabledUiState.widgetValues.at(-1), "function", "repeated enable keeps focused widget installed");
	assert.match(disabledUiState.statusValues.at(-1), /✓ squad 1\/1/, "repeated enable keeps focused status");
});

test("failed disable persistence leaves enabled runtime unchanged", async () => {
	const settingsPath = store.getSquadSettingsPath();
	fs.rmSync(settingsPath, { force: true });
	fs.mkdirSync(settingsPath);
	await disabledApi.commands.get("squad").handler("disable", disabledCtx);
	const status = await disabledApi.tools.get("squad_status").execute("still-enabled", { squadId: disabledSquadId }, undefined, undefined, disabledCtx);
	assert.doesNotMatch(status.content[0].text, /pi-squad is disabled/, "in-memory state changes only after persistence succeeds");
	fs.rmSync(settingsPath, { recursive: true, force: true });
	for (const entry of fs.readdirSync(path.dirname(settingsPath)).filter((name) => name.startsWith("settings.json.tmp."))) fs.rmSync(path.join(path.dirname(settingsPath), entry), { force: true });
	const recovered = store.loadSquadSettings(); recovered.enabled = true; recovered.defaultModel = "legacy-model"; recovered.defaultThinking = "high"; recovered.advisor.maxCallsPerTask = 7; store.saveSquadSettings(recovered);
});

test("disable persists first, suspends and kills live work, closes panel, hides widget, and is idempotent", async () => {
	const liveId = "master-live-disable";
	store.saveSquad(squad(liveId, "paused"));
	store.createTask(liveId, task("live-exact", "suspended"));
	const modify = disabledApi.tools.get("squad_modify");
	const resumed = await modify.execute("resume-live", { action: "resume_task", squadId: liveId, taskId: "live-exact" }, undefined, undefined, disabledCtx);
	assert.match(resumed.content[0].text, /resumed/);
	assert.equal(store.loadTask(liveId, "live-exact").status, "in_progress");
	await disabledApi.commands.get("squad").handler("panel", disabledCtx);
	const beforeDisableRpc = rpcRecords().length;
	await disabledApi.commands.get("squad").handler("disable", disabledCtx);
	assert.equal(store.loadSquadSettings().enabled, false);
	assert.equal(store.loadTask(liveId, "live-exact").status, "suspended");
	assert.ok(rpcRecords().length >= beforeDisableRpc);
	assert.ok(rpcRecords().some((record) => record.kind === "signal" && record.signal === "SIGTERM"), "live child was killed before disable returned");
	assert.equal(disabledUiState.widgetValues.at(-1), undefined, "disable clears widget content");
	assert.equal(disabledUiState.statusValues.at(-1), undefined, "disable clears squad status line");
	assert.doesNotThrow(() => disabledUiState.panel?.handleInput("p"), "an already-created panel callback fails closed");
	const suspendedBytes = fs.readFileSync(store.getTaskFilePath(liveId, "live-exact"), "utf8");
	const rpcAfterDisable = rpcRecords().length;
	assert.doesNotThrow(() => disabledCtx.ui.setWidget);
	await disabledApi.commands.get("squad").handler("disable", disabledCtx);
	assert.equal(fs.readFileSync(store.getTaskFilePath(liveId, "live-exact"), "utf8"), suspendedBytes);
	assert.equal(rpcRecords().length, rpcAfterDisable, "idempotent disable creates no child or scheduler work");
});

test("disabled restart and later enable never auto-resume suspended work", async () => {
	const liveId = "master-live-disable";
	const beforeRpc = rpcRecords().length;
	const uiState = makeUi();
	const ctx = { hasUI: true, cwd: tempHome, ui: uiState.ui, sessionManager: { getSessionFile: () => null } };
	const restarted = createApi(); registerExtension(restarted);
	await emit(restarted, "session_start", {}, ctx);
	assert.equal(store.loadTask(liveId, "live-exact").status, "suspended");
	assert.equal(rpcRecords().length, beforeRpc);
	assert.equal(uiState.terminalHandlers.length, 1);
	assert.deepEqual(uiState.terminalHandlers[0]("\x11"), { consume: true });
	await restarted.commands.get("squad").handler("enable", ctx);
	assert.equal(store.loadTask(liveId, "live-exact").status, "suspended");
	assert.equal(rpcRecords().length, beforeRpc);
	assert.match(uiState.notifications.at(-1).message, /No suspended work was resumed.*explicit/i);
	await emit(restarted, "session_shutdown");
});
