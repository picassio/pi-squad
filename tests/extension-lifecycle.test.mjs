import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import crypto from "node:crypto";
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
fs.appendFileSync(log, JSON.stringify({ kind: "argv", args, specEnv: {
 squadId: process.env.PI_SQUAD_ID, taskId: process.env.PI_SQUAD_TASK_ID,
 path: process.env.PI_SQUAD_SPEC_PATH, sha256: process.env.PI_SQUAD_SPEC_SHA256,
 bytes: process.env.PI_SQUAD_SPEC_BYTES, chunkBytes: process.env.PI_SQUAD_SPEC_CHUNK_BYTES,
} }) + "\\n");
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
		if (command.type === "prompt" && command.message.includes("QA_RPC_AUTO_SETTLE")) {
			setTimeout(() => {
				process.stdout.write(JSON.stringify({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "QA fake RPC work settled" }] },
				}) + "\\n");
				process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
			}, 100);
		}
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
	const commands = new Map();
	const events = new Map();
	const sent = [];
	return {
		tools,
		commands,
		events,
		sent,
		registerTool(definition) { tools.set(definition.name, definition); },
		registerCommand(name, definition) { commands.set(name, definition); },
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
	if (!fs.existsSync(rpcLog)) return [];
	return fs.readFileSync(rpcLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(message);
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

test("failed review can add same-squad rework after restart and requires a fresh passing review", async () => {
	const squadId = "sq-extension-review-rework";
	const originalTaskId = "original-work";
	const failedReview = {
		status: "failed",
		requestedAt: "2026-07-16T10:30:00.000Z",
		completedAt: "2026-07-16T10:31:00.000Z",
		verdict: "fail",
		contractChecks: ["Original behavior remains broken"],
		diffReview: "Inspected the implementation and found the defect.",
		verificationEvidence: ["npm test -> one regression failed"],
		integrationEvidence: "Production-like reproduction failed.",
		issues: ["Fix the failed-review lifecycle"],
	};
	store.saveSquad({
		id: squadId,
		goal: "repair the failed review in the authoritative squad",
		status: "review",
		created: "2026-07-16T10:30:00.000Z",
		cwd: tempHome,
		agents: { backend: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
		review: failedReview,
	});
	store.createTask(squadId, {
		id: originalTaskId,
		title: "Original work",
		description: "The first candidate",
		agent: "backend",
		status: "done",
		depends: [],
		created: "2026-07-16T10:30:00.000Z",
		started: "2026-07-16T10:30:01.000Z",
		completed: "2026-07-16T10:30:30.000Z",
		output: "candidate rejected by review",
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 1 },
	});

	const api = createFakeExtensionApi();
	registerExtension(api);
	const ctx = { hasUI: false, cwd: tempHome };
	await emit(api, "session_start", {}, ctx);

	const review = api.tools.get("squad_review");
	const prematurePass = await review.execute("premature-pass", {
		squadId,
		verdict: "pass",
		contractChecks: ["Claimed fixed without rework"],
		diffReview: "No new rework exists.",
		verificationEvidence: ["No fresh verification exists."],
		integrationEvidence: "Not rerun.",
		issues: [],
	}, undefined, undefined, ctx);
	assert.match(prematurePass.content[0].text, /Review rejected: .*already failed/);
	assert.deepEqual(store.loadSquad(squadId).review, failedReview, "a second verdict cannot overwrite the failed gate");

	const modify = api.tools.get("squad_modify");
	const resumeResult = await modify.execute("reconstruct-review", {
		action: "resume",
		squadId,
	}, undefined, undefined, ctx);
	assert.match(resumeResult.content[0].text, /Squad .* resumed/);
	assert.equal(store.loadSquad(squadId).status, "review", "resume reconstruction alone cannot bypass a failed gate without resumable work");
	assert.deepEqual(store.loadSquad(squadId).review, failedReview);

	const addResult = await modify.execute("add-rework", {
		action: "add_task",
		squadId,
		task: {
			id: "review-fix",
			title: "Fix failed review",
			description: "Address the recorded failed-review issue",
			agent: "backend",
			depends: [originalTaskId],
		},
	}, undefined, undefined, ctx);
	assert.match(addResult.content[0].text, /Task 'review-fix' added/);
	assert.equal(store.loadTask(squadId, "review-fix").status, "in_progress", "new rework starts on a reconstructed scheduler");
	let squad = store.loadSquad(squadId);
	assert.equal(squad.status, "running");
	assert.equal(squad.review, undefined, "failed gate is no longer the active attempt during rework");
	assert.deepEqual(squad.reviewHistory, [failedReview], "failed evidence remains in same-squad history");

	const settleResult = await modify.execute("settle-rework", {
		action: "complete_task",
		squadId,
		taskId: "review-fix",
		output: "failed-review lifecycle repaired",
	}, undefined, undefined, ctx);
	assert.match(settleResult.content[0].text, /marked done/);
	squad = store.loadSquad(squadId);
	assert.equal(squad.status, "review", "settled rework creates a fresh mandatory gate");
	assert.equal(squad.review.status, "pending");
	assert.deepEqual(squad.reviewHistory, [failedReview]);

	const passResult = await review.execute("pass-rework", {
		squadId,
		verdict: "pass",
		contractChecks: ["Same-squad rework completed"],
		diffReview: "Inspected the rework in the authoritative squad.",
		verificationEvidence: ["public lifecycle regression passed"],
		integrationEvidence: "Restart, scheduler reconstruction, rework, and settlement exercised through public tools.",
		issues: [],
	}, undefined, undefined, ctx);
	assert.match(passResult.content[0].text, /accepted as done/);
	squad = store.loadSquad(squadId);
	assert.equal(squad.status, "done");
	assert.equal(squad.review.status, "passed", "fresh review replaces the active gate");
	assert.deepEqual(squad.reviewHistory, [failedReview], "the original failure remains auditable after acceptance");

	await emit(api, "session_shutdown");
});

test("public tools preserve the failed gate across restart until fake-RPC rework agent_settled and fresh review", async (t) => {
	const ctx = {
		hasUI: false,
		cwd: tempHome,
		sessionManager: { getSessionFile: () => null },
	};
	const startParams = (goal, taskId) => ({
		goal,
		tasks: [{
			id: taskId,
			title: "Fake RPC lifecycle work",
			description: "QA_RPC_AUTO_SETTLE. Verify the fake RPC agent_settled lifecycle.",
			agent: "backend",
			depends: [],
		}],
		config: { maxConcurrency: 1 },
	});
	const reviewEvidence = (verdict, issue = []) => ({
		verdict,
		contractChecks: ["Observed the exact public-tool lifecycle"],
		diffReview: "Inspected same-squad persisted state and review history.",
		verificationEvidence: ["Fake Pi RPC emitted message_end then agent_settled."],
		integrationEvidence: "Extension tools, scheduler reconstruction, child RPC, and file-backed store were exercised together.",
		issues: issue,
	});

	const firstApi = createFakeExtensionApi();
	registerExtension(firstApi);
	await emit(firstApi, "session_start", {}, ctx);
	const initialResult = await firstApi.tools.get("squad").execute(
		"initial-squad",
		startParams("QA authoritative failed-review RPC lifecycle", "initial-work"),
		undefined,
		undefined,
		ctx,
	);
	const squadId = initialResult.content[0].text.match(/Squad "([^"]+)"/)?.[1];
	assert.ok(squadId);
	await waitFor(
		() => store.loadSquad(squadId)?.review?.status === "pending",
		"initial agent_settled did not create the mandatory pending review",
	);
	assert.equal(store.loadTask(squadId, "initial-work").status, "done");

	const failedResult = await firstApi.tools.get("squad_review").execute(
		"fail-initial",
		{ squadId, ...reviewEvidence("fail", ["Rework is required"]) },
		undefined,
		undefined,
		ctx,
	);
	assert.match(failedResult.content[0].text, /review FAILED/i);
	const failedReview = store.loadSquad(squadId).review;
	assert.equal(failedReview.status, "failed");

	const unrelatedResult = await firstApi.tools.get("squad").execute(
		"unrelated-squad",
		startParams("QA unrelated RPC lifecycle", "unrelated-work"),
		undefined,
		undefined,
		ctx,
	);
	const unrelatedId = unrelatedResult.content[0].text.match(/Squad "([^"]+)"/)?.[1];
	assert.ok(unrelatedId);
	await waitFor(
		() => store.loadSquad(unrelatedId)?.review?.status === "pending",
		"unrelated agent_settled did not create its pending review",
	);
	await firstApi.tools.get("squad_review").execute(
		"pass-unrelated",
		{ squadId: unrelatedId, ...reviewEvidence("pass") },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(store.loadSquad(unrelatedId).status, "done");
	assert.equal(store.loadSquad(squadId).review.status, "failed", "unrelated acceptance cannot alter the authoritative gate");

	await emit(firstApi, "session_shutdown");

	const restartedApi = createFakeExtensionApi();
	registerExtension(restartedApi);
	await emit(restartedApi, "session_start", {}, ctx);
	assert.ok(
		restartedApi.sent.some((entry) => entry.message.customType === "squad-review-required"),
		"restart must restore the failed review gate",
	);
	const modify = restartedApi.tools.get("squad_modify");
	const bareResume = await modify.execute("bare-resume", { action: "resume", squadId }, undefined, undefined, ctx);
	assert.match(bareResume.content[0].text, /resumed/);
	assert.equal(store.loadSquad(squadId).review.status, "failed", "scheduler reconstruction alone cannot clear the gate");

	const addResult = await modify.execute("add-rpc-rework", {
		action: "add_task",
		squadId,
		task: {
			id: "rpc-rework",
			title: "Rework through fake Pi RPC",
			description: "QA_RPC_AUTO_SETTLE. Verify fresh agent_settled review gating.",
			agent: "backend",
			depends: ["initial-work"],
		},
	}, undefined, undefined, ctx);
	assert.match(addResult.content[0].text, /added to squad/);
	assert.equal(store.loadSquad(squadId).status, "running");
	assert.equal(store.loadSquad(squadId).review, undefined);
	assert.deepEqual(store.loadSquad(squadId).reviewHistory, [failedReview]);

	await waitFor(
		() => store.loadSquad(squadId)?.review?.status === "pending",
		"rework agent_settled did not create a fresh mandatory review",
	);
	assert.equal(store.loadTask(squadId, "rpc-rework").status, "done");
	assert.deepEqual(store.loadSquad(squadId).reviewHistory, [failedReview]);

	const passResult = await restartedApi.tools.get("squad_review").execute(
		"pass-rework",
		{ squadId, ...reviewEvidence("pass") },
		undefined,
		undefined,
		ctx,
	);
	assert.match(passResult.content[0].text, /accepted as done/);
	assert.equal(store.loadSquad(squadId).status, "done");
	assert.equal(store.loadSquad(squadId).review.status, "passed");
	assert.deepEqual(store.loadSquad(squadId).reviewHistory, [failedReview]);
	assert.equal(store.loadSquad(unrelatedId).status, "done");

	const rpcRecords = readRpcLog();
	assert.ok(rpcRecords.filter((record) => record.kind === "rpc" && record.command.type === "prompt").length >= 3);
	t.diagnostic(`authoritative squad: ${squadId}`);
	t.diagnostic(`review history retained: ${store.loadSquad(squadId).reviewHistory.length}`);
	await emit(restartedApi, "session_shutdown");
});

test("resume_task reconstructs the failed-review squad and reopens the exact durable task", async () => {
	const squadId = "sq-extension-review-resume-task";
	const taskId = "resume-original";
	const originalSession = path.join(store.getTaskSessionDir(squadId, taskId), "resume-original.jsonl");
	const failedReview = {
		status: "failed",
		requestedAt: "2026-07-16T10:40:00.000Z",
		completedAt: "2026-07-16T10:41:00.000Z",
		verdict: "fail",
		contractChecks: ["Resume behavior failed"],
		diffReview: "Inspected resume behavior.",
		verificationEvidence: ["restart repro failed"],
		integrationEvidence: "Public tool could not reopen the task.",
		issues: ["Resume the exact task"],
	};
	store.saveSquad({
		id: squadId,
		goal: "resume exact same-squad task",
		status: "review",
		created: "2026-07-16T10:40:00.000Z",
		cwd: tempHome,
		agents: { backend: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
		review: failedReview,
	});
	store.createTask(squadId, {
		id: taskId,
		title: "Resume original",
		description: "Continue in the original session",
		agent: "backend",
		status: "done",
		depends: [],
		created: "2026-07-16T10:40:00.000Z",
		started: "2026-07-16T10:40:01.000Z",
		completed: "2026-07-16T10:40:30.000Z",
		output: "first rejected candidate",
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 1 },
	});
	store.bindTaskSession(squadId, taskId, { file: originalSession, sessionId: "resume-original-session" });
	const rpcBefore = readRpcLog().length;

	const api = createFakeExtensionApi();
	registerExtension(api);
	const ctx = { hasUI: false, cwd: tempHome };
	await emit(api, "session_start", {}, ctx);
	const result = await api.tools.get("squad_modify").execute("resume-task", {
		action: "resume_task",
		squadId,
		taskId,
	}, undefined, undefined, ctx);
	assert.match(result.content[0].text, /resumed in squad/);
	assert.equal(store.loadTask(squadId, taskId).status, "in_progress");
	const squad = store.loadSquad(squadId);
	assert.equal(squad.status, "running");
	assert.equal(squad.review, undefined);
	assert.deepEqual(squad.reviewHistory, [failedReview]);
	const argv = readRpcLog().slice(rpcBefore).find((record) => record.kind === "argv")?.args;
	assert.deepEqual(argv?.slice(0, 4), ["--mode", "rpc", "--session", originalSession]);

	await emit(api, "session_shutdown");
});

test("slash resume reconstructs the exact failed-review squad when resumable work exists", async () => {
	const squadId = "sq-extension-slash-resume";
	const taskId = "suspended-rework";
	const originalSession = path.join(store.getTaskSessionDir(squadId, taskId), "slash-resume.jsonl");
	const failedReview = {
		status: "failed",
		requestedAt: "2026-07-16T10:50:00.000Z",
		completedAt: "2026-07-16T10:51:00.000Z",
		verdict: "fail",
		contractChecks: ["Slash resume failed"],
		diffReview: "Inspected slash behavior.",
		verificationEvidence: ["slash repro failed"],
		integrationEvidence: "Restarted extension could not resume rework.",
		issues: ["Restore slash resume"],
	};
	store.saveSquad({
		id: squadId,
		goal: "resume failed-review rework from slash command",
		status: "review",
		created: "2026-07-16T10:50:00.000Z",
		cwd: tempHome,
		agents: { backend: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
		review: failedReview,
	});
	store.createTask(squadId, {
		id: taskId,
		title: "Suspended rework",
		description: "Resume the interrupted same-squad fix",
		agent: "backend",
		status: "suspended",
		depends: [],
		created: "2026-07-16T10:50:00.000Z",
		started: "2026-07-16T10:50:01.000Z",
		completed: null,
		output: null,
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 1 },
	});
	store.bindTaskSession(squadId, taskId, { file: originalSession, sessionId: "slash-resume-session" });

	const api = createFakeExtensionApi();
	registerExtension(api);
	const notifications = [];
	const ctx = { hasUI: false, cwd: tempHome, ui: { notify: (message, level) => notifications.push({ message, level }) } };
	await emit(api, "session_start", {}, ctx);
	await api.commands.get("squad").handler(`resume ${squadId}`, ctx);

	assert.equal(store.loadTask(squadId, taskId).status, "in_progress");
	const squad = store.loadSquad(squadId);
	assert.equal(squad.status, "running");
	assert.equal(squad.review, undefined);
	assert.deepEqual(squad.reviewHistory, [failedReview]);
	assert.ok(notifications.some(({ message }) => message.includes(`Resumed: ${squadId}`)));

	await emit(api, "session_shutdown");
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

test("squad_modify RPC repairs dependencies then durably cancels obsolete work after restart", async () => {
	const squadId = "sq-extension-cancel-repair";
	store.saveSquad({
		id: squadId,
		goal: "repair obsolete QA dependency",
		status: "failed",
		created: "2026-07-17T04:00:00.000Z",
		cwd: tempHome,
		agents: { backend: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	});
	for (const task of [
		{ id: "old-qa", status: "failed", depends: [], error: "obsolete failure" },
		{ id: "replacement-qa", status: "done", depends: [], error: null },
		{ id: "final-check", status: "blocked", depends: ["old-qa"], error: null },
	]) {
		store.createTask(squadId, {
			...task, title: task.id, description: task.id, agent: "backend",
			created: store.now(), started: null, completed: task.status === "done" ? store.now() : null,
			output: task.status === "done" ? "replacement passed" : null,
			usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
		});
	}

	const api = createFakeExtensionApi();
	registerExtension(api);
	const ctx = { hasUI: false, cwd: tempHome };
	await emit(api, "session_start", {}, ctx);
	const modify = api.tools.get("squad_modify");

	const refused = await modify.execute("cancel-refused", {
		action: "cancel_task", squadId, taskId: "old-qa",
	}, undefined, undefined, ctx);
	assert.match(refused.content[0].text, /Cannot cancel task 'old-qa'/);
	assert.match(refused.content[0].text, /final-check \[blocked\]/);
	assert.equal(store.loadTask(squadId, "old-qa").status, "failed");

	const repaired = await modify.execute("repair-dependency", {
		action: "set_dependencies", squadId, taskId: "final-check", depends: ["replacement-qa"],
	}, undefined, undefined, ctx);
	assert.match(repaired.content[0].text, /dependencies updated/);
	await waitFor(() => store.loadTask(squadId, "final-check").status === "in_progress", "repaired task should schedule in the same squad");
	assert.equal(store.loadSquad(squadId).status, "running");
	assert.deepEqual(store.loadTask(squadId, "final-check").depends, ["replacement-qa"]);

	const cancelled = await modify.execute("cancel-safe", {
		action: "cancel_task", squadId, taskId: "old-qa",
	}, undefined, undefined, ctx);
	assert.match(cancelled.content[0].text, /cancelled/);
	assert.equal(store.loadTask(squadId, "old-qa").status, "cancelled");
	assert.equal(store.loadTask(squadId, "old-qa").error, null);

	const status = await api.tools.get("squad_status").execute("status-after-cancel", {
		squadId,
	}, undefined, undefined, ctx);
	assert.match(status.content[0].text, /⊘ old-qa .*\[cancelled\]/);
	assert.match(status.content[0].text, /Progress: 1\/2 active tasks done · 1 cancelled · 3 total/);

	await emit(api, "session_shutdown");
	assert.equal(store.loadTask(squadId, "old-qa").status, "cancelled");
});

test("real Pi RPC resume_task revives a cancelled task on its exact session and durable mailbox", async () => {
	const squadId = "sq-extension-cancelled-resume";
	const taskId = "cancelled-work";
	const originalSession = path.join(store.getTaskSessionDir(squadId, taskId), "cancelled-original.jsonl");
	store.saveSquad({
		id: squadId,
		goal: "resume cancelled durable session",
		status: "review",
		created: "2026-07-17T04:10:00.000Z",
		cwd: tempHome,
		agents: { backend: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	});
	store.createTask(squadId, {
		id: taskId, title: taskId, description: taskId, agent: "backend", status: "cancelled", depends: [],
		created: store.now(), started: store.now(), completed: store.now(), output: "preserved prior output", error: null,
		usage: { inputTokens: 4, outputTokens: 5, cost: 0.02, turns: 1 },
	});
	store.bindTaskSession(squadId, taskId, { file: originalSession, sessionId: "original-session-id" });
	const pending = store.queueTaskMessage(squadId, taskId, {
		ts: store.now(), from: "orchestrator", type: "message", text: "resume cancelled mailbox EXACT-END", expectsReply: true,
	});
	const rpcBefore = readRpcLog().length;

	const api = createFakeExtensionApi();
	registerExtension(api);
	const ctx = { hasUI: false, cwd: tempHome };
	await emit(api, "session_start", {}, ctx);
	assert.equal(store.loadTask(squadId, taskId).status, "cancelled", "restart mailbox recovery must not revive cancelled work");
	assert.equal(store.loadPendingTaskMessages(squadId, taskId).length, 1);

	const resumed = await api.tools.get("squad_modify").execute("resume-cancelled", {
		action: "resume_task", squadId, taskId,
	}, undefined, undefined, ctx);
	assert.match(resumed.content[0].text, /resumed/);
	await waitFor(() => store.loadTask(squadId, taskId).status === "in_progress", "cancelled task should resume on explicit resume_task");
	assert.deepEqual(store.loadTaskSession(squadId, taskId), { file: originalSession, sessionId: "original-session-id" });
	assert.equal(store.loadPendingTaskMessages(squadId, taskId).length, 0);
	assert.ok(store.loadTaskMailbox(squadId, taskId).some((entry) => entry.id === pending.id), "acknowledgement retains mailbox history");

	const records = readRpcLog().slice(rpcBefore);
	const argv = records.find((record) => record.kind === "argv")?.args;
	assert.deepEqual(argv?.slice(0, 4), ["--mode", "rpc", "--session", originalSession]);
	const prompt = records.find((record) => record.kind === "rpc" && record.command.type === "prompt")?.command.message;
	assert.ok(prompt?.includes("resume cancelled mailbox EXACT-END"));

	await emit(api, "session_shutdown");
});

test("destructive cancel requires an exact squad and never retargets the focused live squad", async () => {
	const squadA = "sq-exact-cancel-a";
	const squadB = "sq-exact-cancel-b";
	const squadC = "sq-exact-cancel-no-scheduler";
	for (const [id, created] of [
		[squadA, "2026-07-18T01:00:00.000Z"],
		[squadB, "2026-07-18T01:01:00.000Z"],
		[squadC, "2026-07-18T01:02:00.000Z"],
	]) {
		const suspended = id !== squadC;
		store.saveSquad({
			id, goal: id, status: suspended ? "paused" : "running", created, cwd: tempHome,
			agents: { backend: {} }, config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
		});
		store.createTask(id, {
			id: `${id}-task`, title: id, description: id, agent: "backend", status: suspended ? "suspended" : "pending", depends: [],
			created, started: null, completed: null, output: null, error: null, usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
		});
	}
	const api = createFakeExtensionApi();
	registerExtension(api);
	const ctx = { hasUI: false, cwd: tempHome };
	await emit(api, "session_start", {}, ctx);
	const modify = api.tools.get("squad_modify");
	await modify.execute("start-b", { action: "resume_task", squadId: squadB, taskId: `${squadB}-task` }, undefined, undefined, ctx);
	await waitFor(() => store.loadTask(squadB, `${squadB}-task`).status === "in_progress", "B should also have a live scheduler");
	const rpcBefore = readRpcLog().length;
	await modify.execute("focus-a", { action: "resume_task", squadId: squadA, taskId: `${squadA}-task` }, undefined, undefined, ctx);
	await waitFor(() => store.loadTask(squadA, `${squadA}-task`).status === "in_progress", "A should be live and focused");
	const redundant = await modify.execute("redundant-resume-a", { action: "resume_task", squadId: squadA, taskId: `${squadA}-task` }, undefined, undefined, ctx);
	assert.match(redundant.content[0].text, new RegExp(`already running in squad '${squadA}'.*no duplicate`));
	assert.equal(readRpcLog().slice(rpcBefore).filter((record) => record.kind === "argv").length, 1, "redundant exact resume must not spawn another child");

	const omitted = await modify.execute("cancel-omitted", { action: "cancel" }, undefined, undefined, ctx);
	assert.match(omitted.content[0].text, /requires exact squadId/);
	assert.equal(store.loadSquad(squadA).status, "running");
	assert.equal(store.loadSquad(squadB).status, "running");
	assert.equal(store.loadSquad(squadC).status, "running");
	const cancelB = await modify.execute("cancel-b", { action: "cancel", squadId: squadB }, undefined, undefined, ctx);
	assert.equal(cancelB.content[0].text, `Squad '${squadB}' cancelled.`);
	assert.equal(store.loadSquad(squadB).status, "failed");
	assert.equal(store.loadTask(squadB, `${squadB}-task`).status, "suspended", "only B's live child is stopped");
	assert.equal(store.loadSquad(squadA).status, "running");
	assert.equal(store.loadTask(squadA, `${squadA}-task`).status, "in_progress", "cancelling B must not stop A");
	const cancelC = await modify.execute("cancel-c", { action: "cancel", squadId: squadC }, undefined, undefined, ctx);
	assert.equal(cancelC.content[0].text, `Squad '${squadC}' cancelled.`);
	assert.equal(store.loadSquad(squadC).status, "failed", "persisted squad without a scheduler is cancelled exactly");
	assert.equal(store.loadTask(squadA, `${squadA}-task`).status, "in_progress");
	const unknown = await modify.execute("cancel-unknown", { action: "cancel", squadId: "missing-exact-squad" }, undefined, undefined, ctx);
	assert.equal(unknown.content[0].text, "Squad 'missing-exact-squad' not found; no squad was changed.");
	assert.equal(store.loadSquad(squadA).status, "running");
	const cancelA = await modify.execute("cancel-a", { action: "cancel", squadId: squadA }, undefined, undefined, ctx);
	assert.equal(cancelA.content[0].text, `Squad '${squadA}' cancelled.`);
	assert.equal(store.loadSquad(squadA).status, "failed");
	assert.equal(store.loadTask(squadA, `${squadA}-task`).status, "suspended");
	assert.equal(store.loadSquad(squadB).status, "failed");
	await emit(api, "session_shutdown");
});

test("restart delivers one durable suspended-stall wake and exact resume clears it without auto-resuming descendants", async () => {
	const squadId = "sq-extension-suspended-stall";
	store.saveSquad({
		id: squadId, goal: "wake suspended work", status: "paused", created: "2026-07-18T02:00:00.000Z", cwd: tempHome,
		agents: { backend: {} }, config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	});
	for (const task of [
		{ id: "suspended-root-exact", status: "suspended", depends: [] },
		{ id: "blocked-child-exact", status: "blocked", depends: ["suspended-root-exact"] },
		{ id: "blocked-grandchild-exact", status: "blocked", depends: ["blocked-child-exact"] },
	]) {
		store.createTask(squadId, {
			...task, title: task.id, description: task.id, agent: "backend", created: store.now(), started: null,
			completed: null, output: null, error: null, usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
		});
	}
	const api = createFakeExtensionApi();
	registerExtension(api);
	const ctx = { hasUI: false, cwd: tempHome };
	await emit(api, "session_start", {}, ctx);
	const wakes = api.sent.filter((entry) => entry.message.customType?.startsWith(`squad-suspended-stall:${squadId}:`));
	assert.equal(wakes.length, 1);
	assert.match(wakes[0].message.content, /Suspended task IDs: suspended-root-exact/);
	assert.match(wakes[0].message.content, /Blocked by suspended work: blocked-child-exact, blocked-grandchild-exact/);
	assert.match(wakes[0].message.content, new RegExp(`squadId: "${squadId}"`));
	assert.match(wakes[0].message.content, /No task was resumed automatically/);
	assert.equal(store.loadSquad(squadId).suspendedStallAttention.delivery, "delivered");
	assert.equal(store.loadTask(squadId, "suspended-root-exact").status, "suspended");

	await emit(api, "session_shutdown");
	const restartedApi = createFakeExtensionApi();
	registerExtension(restartedApi);
	await emit(restartedApi, "session_start", {}, ctx);
	assert.equal(restartedApi.sent.filter((entry) => entry.message.customType?.startsWith(`squad-suspended-stall:${squadId}:`)).length, 0,
		"delivered attention must not storm after restart");
	const resumed = await restartedApi.tools.get("squad_modify").execute("resume-root", {
		action: "resume_task", squadId, taskId: "suspended-root-exact",
	}, undefined, undefined, ctx);
	assert.match(resumed.content[0].text, /resumed in squad/);
	await waitFor(() => store.loadTask(squadId, "suspended-root-exact").status === "in_progress", "exact root should resume");
	assert.equal(store.loadTask(squadId, "blocked-child-exact").status, "blocked");
	assert.equal(store.loadTask(squadId, "blocked-grandchild-exact").status, "blocked");
	assert.equal(store.loadSquad(squadId).suspendedStallAttention, undefined);
	await emit(restartedApi, "session_shutdown");
});

test("file-spec publication rejects inconsistent metadata and unsafe task paths without partial discovery", () => {
	const raw = Buffer.from("{\"schemaVersion\":1}\n");
	const id = "atomic-file-publish";
	const specPath = path.join(store.getSquadDir(id), "spec", "spec.v1.json");
	const baseSquad = {
		id, goal: "atomic publish", status: "running", created: store.now(), cwd: tempHome, agents: { backend: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
		spec: { schemaVersion: 1, sha256: "0".repeat(64), bytes: raw.length, path: specPath, chunkBytes: 32768, chunkCount: 1 },
	};
	const baseTask = { id: "safe-task", title: "safe", description: "safe", agent: "backend", status: "pending", depends: [], created: store.now(), started: null, completed: null, output: null, error: null, usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 } };
	assert.throws(() => store.publishFileSquad(baseSquad, [baseTask], raw), /PUBLISH_FAILED.*canonical bytes/);
	assert.equal(fs.existsSync(store.getSquadDir(id)), false);
	const validSquad = { ...baseSquad, spec: { ...baseSquad.spec, sha256: crypto.createHash("sha256").update(raw).digest("hex") } };
	assert.throws(() => store.publishFileSquad(validSquad, [{ ...baseTask, id: "../escape" }], raw), /PUBLISH_FAILED.*unsafe/);
	assert.equal(fs.existsSync(store.getSquadDir(id)), false);
	assert.equal(store.listSquads().includes(id), false);
	assert.equal(fs.readdirSync(store.getSquadRoot()).some(entry => entry.startsWith(`${id}.creating.`)), false);
});

test("cancelled file-spec needs no attestation: public call publishes exact bytes and child manifest", async () => {
	const crypto = await import("node:crypto");
	const backendDef = store.loadAgentDef("backend", tempHome); const originalTools = backendDef.tools; backendDef.tools = ["bash"]; store.saveAgentDef(backendDef);
	const api = createFakeExtensionApi(); registerExtension(api);
	const ctx = { hasUI: false, cwd: tempHome, sessionManager: { getSessionFile: () => null } };
	const spec = {
		schemaVersion: 1,
		goal: "File API child-process integration",
		tasks: [{ id: "file-worker", title: "File worker", description: "Goal: verify file transport. Verify: npm test", agent: "backend", depends: [], inheritContext: false, artifactRefs: [] }],
		agents: { backend: { model: null, thinking: null } },
		config: { maxConcurrency: 1, autoUnblock: true, maxRetries: 1 },
		artifacts: [],
	};
	const raw = Buffer.from(JSON.stringify(spec, null, 2) + "\n");
	const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
	const specFile = path.join(tempHome, "large-contract.json"); fs.writeFileSync(specFile, raw);
	const before = new Set(store.listSquads());
	await assert.rejects(() => api.tools.get("squad").execute("bad-file", { specFile, specSha256: "0".repeat(64) }, undefined, undefined, ctx), /SPEC_HASH_MISMATCH/);
	assert.deepEqual(new Set(store.listSquads()), before, "hash rejection publishes no discoverable squad");
	const result = await api.tools.get("squad").execute("good-file", { specFile, specSha256: sha256 }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /started with 1 tasks/);
	assert.match(result.content[0].text, new RegExp(`SHA-256: ${sha256}`));
	assert.doesNotMatch(result.content[0].text, /File worker|Goal: verify file transport/,
		"file start response must stay descriptor-sized instead of reflecting task contracts into the main session");
	const created = store.listSquads().map(id => store.loadSquad(id)).find(squad => squad?.goal === spec.goal);
	assert.ok(created?.spec);
	assert.deepEqual(fs.readFileSync(created.spec.path), raw, "canonical publication preserves every byte");
	assert.equal(created.spec.sha256, sha256);
	await waitFor(() => readRpcLog().some(record => record.kind === "argv" && record.specEnv?.squadId === created.id), "file child spawn env");
	const spawn = readRpcLog().find(record => record.kind === "argv" && record.specEnv?.squadId === created.id);
	assert.deepEqual(spawn.specEnv, { squadId: created.id, taskId: "file-worker", path: created.spec.path, sha256, bytes: String(raw.length), chunkBytes: "32768" });
	const toolsIndex = spawn.args.indexOf("--tools"); assert.ok(toolsIndex >= 0); assert.equal(spawn.args[toolsIndex + 1], "bash,squad_spec_read", "file reader is force-added to child tool allowlists");
	await api.tools.get("squad").execute("collision-file", { specFile, specSha256: sha256 }, undefined, undefined, ctx);
	const collision = store.listSquads().map(id => store.loadSquad(id)).find(squad => squad?.goal === spec.goal && squad.id !== created.id);
	assert.ok(collision?.id.startsWith(`${created.id}-`), "an existing published ID resolves to a distinct safe directory");
	assert.deepEqual(fs.readFileSync(collision.spec.path), raw);
	await api.tools.get("squad_modify").execute("cancel-collision", { squadId: collision.id, action: "cancel" }, undefined, undefined, ctx);
	await api.tools.get("squad_modify").execute("cancel-file", { squadId: created.id, action: "cancel" }, undefined, undefined, ctx);
	await emit(api, "session_shutdown"); backendDef.tools = originalTools; store.saveAgentDef(backendDef);
});
