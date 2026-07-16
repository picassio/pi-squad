import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try { return nextResolve(specifier, context); }
			catch { return nextResolve(specifier.replace(/\.js$/, ".ts"), context); }
		}
		return nextResolve(specifier, context);
	},
});

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-task-durability-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const store = await import("../src/store.ts");

function createTask(squadId, taskId = "implementation", agent = "backend") {
	store.createTask(squadId, {
		id: taskId,
		title: "Implementation",
		description: "Implement the contract",
		agent,
		status: "pending",
		depends: [],
		created: store.now(),
		started: null,
		completed: null,
		output: null,
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
	});
}

test("a task binds one immutable durable Pi session independent of agent name", () => {
	const squadId = "sq-task-session";
	createTask(squadId);
	createTask(squadId, "other-task", "backend");
	const sessionDir = store.getTaskSessionDir(squadId, "implementation");
	assert.equal(sessionDir, path.join(store.getTaskDir(squadId, "implementation"), "session"));

	const sessionFile = path.join(sessionDir, "2026-07-16_task-session.jsonl");
	assert.deepEqual(
		store.bindTaskSession(squadId, "implementation", { file: sessionFile, sessionId: "pi-session-1" }),
		{ file: sessionFile, sessionId: "pi-session-1" },
	);
	assert.deepEqual(store.loadTaskSession(squadId, "implementation"), {
		file: sessionFile,
		sessionId: "pi-session-1",
	});
	assert.equal(store.loadTaskSession(squadId, "other-task"), null, "same agent does not share session identity");

	// Rebinding the same identity is safe after scheduler/process reconstruction.
	assert.deepEqual(
		store.bindTaskSession(squadId, "implementation", { file: sessionFile, sessionId: "pi-session-1" }),
		{ file: sessionFile, sessionId: "pi-session-1" },
	);

	assert.throws(
		() => store.bindTaskSession(squadId, "implementation", {
			file: path.join(sessionDir, "replacement.jsonl"),
			sessionId: "pi-session-2",
		}),
		/already bound/,
	);
	assert.equal(store.loadTask(squadId, "implementation").agent, "backend");
	assert.equal(store.loadTaskSession(squadId, "implementation").file, sessionFile);
});

test("same-file provisional session IDs can recover before the first prompt without weakening file identity", () => {
	const squadId = "sq-provisional-session";
	createTask(squadId);
	const sessionFile = path.join(store.getTaskSessionDir(squadId, "implementation"), "provisional.jsonl");

	store.bindTaskSession(squadId, "implementation", { file: sessionFile, sessionId: "provisional-id-1" });
	assert.equal(fs.existsSync(sessionFile), false, "Pi does not create the JSONL until its first accepted prompt");
	assert.deepEqual(
		store.bindTaskSession(squadId, "implementation", { file: sessionFile, sessionId: "provisional-id-2" }),
		{ file: sessionFile, sessionId: "provisional-id-2" },
		"retrying the same not-yet-materialized file may replace Pi's provisional ID",
	);

	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "provisional-id-2" })}\n`);
	assert.throws(
		() => store.bindTaskSession(squadId, "implementation", { file: sessionFile, sessionId: "different-materialized-id" }),
		/already bound/,
		"once materialized, a mismatched ID must not replace the durable identity",
	);
});

test("task-addressed mailbox survives restart, preserves full history, and acknowledges without deletion", () => {
	const squadId = "sq-task-mailbox";
	createTask(squadId, "first-task", "backend");
	createTask(squadId, "second-task", "backend");
	const text = `ORCHESTRATOR-START\n${"detail\n".repeat(3000)}ORCHESTRATOR-END`;

	const queued = store.queueTaskMessage(squadId, "first-task", {
		ts: store.now(),
		from: "orchestrator",
		type: "message",
		text,
		expectsReply: true,
	});
	assert.equal(queued.taskId, "first-task");
	assert.equal(queued.deliveredAt, null);
	assert.equal(queued.message.text, text);
	assert.equal(queued.message.id, queued.id);
	assert.equal(store.queueTaskMessage(squadId, "first-task", queued.message).id, queued.id, "retrying a stable message ID is idempotent");

	assert.deepEqual(
		store.loadPendingTaskMessages(squadId, "first-task").map((entry) => entry.id),
		[queued.id],
	);
	assert.deepEqual(store.loadPendingTaskMessages(squadId, "second-task"), [], "same agent does not share a queue");
	assert.equal(
		store.loadMessages(squadId, "first-task").filter((message) => message.id === queued.id).length,
		1,
		"mailbox/history merge de-duplicates the durable message",
	);
	assert.equal(store.loadMessages(squadId, "first-task").at(-1).text, text, "history is never truncated");

	assert.equal(store.acknowledgeTaskMessages(squadId, "first-task", [queued.id]), 1);
	assert.deepEqual(store.loadPendingTaskMessages(squadId, "first-task"), []);
	const retained = store.loadTaskMailbox(squadId, "first-task");
	assert.equal(retained.length, 1, "delivery acknowledgement must not erase older history");
	assert.ok(retained[0].deliveredAt);
	assert.equal(retained[0].message.text, text);
	assert.equal(store.acknowledgeTaskMessages(squadId, "first-task", [queued.id]), 0, "acknowledgement is idempotent");

	assert.throws(
		() => store.queueTaskMessage(squadId, "missing-task", {
			ts: store.now(), from: "human", type: "message", text: "do not create an agent queue",
		}),
		/Task not found/,
	);
});

test("concurrent mailbox queue and acknowledgement mutations are lossless across processes", async () => {
	const squadId = "sq-concurrent-mailbox";
	const taskId = "implementation";
	createTask(squadId, taskId);
	store.queueTaskMessage(squadId, taskId, {
		id: "seed-to-ack",
		ts: store.now(),
		from: "orchestrator",
		type: "message",
		text: "seed",
	});

	const worker = path.join(testsDir, "fixtures", "mailbox-worker.mjs");
	const storeUrl = pathToFileURL(path.join(testsDir, "..", "src", "store.ts")).href;
	const runDir = fs.mkdtempSync(path.join(tempHome, "mailbox-workers-"));
	const barrier = path.join(runDir, "go");
	const operations = [
		["ack", "seed-to-ack"],
		...Array.from({ length: 16 }, (_, index) => ["queue", `queued-${index}`]),
	];
	const children = operations.map(([action, value], index) => {
		const ready = path.join(runDir, `ready-${index}`);
		const child = spawn(process.execPath, [worker, storeUrl, squadId, taskId, action, value, ready, barrier], {
			env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { child, ready, stdout: "", stderr: "" };
	});

	for (let i = 0; i < 500 && children.some(({ ready }) => !fs.existsSync(ready)); i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(children.every(({ ready }) => fs.existsSync(ready)), "every worker reached the concurrency barrier");
	fs.writeFileSync(barrier, "go");
	await Promise.all(children.map(({ child }, index) => new Promise((resolve, reject) => {
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker ${index} exited ${code}: ${stderr}`)));
	})));

	const mailbox = store.loadTaskMailbox(squadId, taskId);
	assert.equal(mailbox.length, operations.length, "no concurrent queue entry may be overwritten");
	assert.equal(mailbox.find((entry) => entry.id === "seed-to-ack")?.deliveredAt !== null, true, "concurrent acknowledgement must survive queue writes");
	for (let index = 0; index < 16; index++) {
		assert.ok(mailbox.some((entry) => entry.id === `queued-${index}`), `queued-${index} survives`);
	}
});
