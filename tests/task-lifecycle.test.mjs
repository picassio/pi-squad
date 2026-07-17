import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try { return nextResolve(specifier, context); }
			catch { return nextResolve(specifier.replace(/\.js$/, ".ts"), context); }
		}
		return nextResolve(specifier, context);
	},
});

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-task-lifecycle-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const store = await import("../src/store.ts");
const { Scheduler } = await import("../src/scheduler.ts");

store.saveAgentDef({
	name: "backend",
	role: "Backend Engineer",
	description: "test agent",
	model: null,
	tools: null,
	tags: [],
	prompt: "",
});

let counter = 0;
function createSquad(tasks, status = "running") {
	const id = `sq-task-lifecycle-${++counter}`;
	store.saveSquad({
		id,
		goal: "durable task lifecycle",
		status,
		created: store.now(),
		cwd: tempHome,
		agents: { backend: {} },
		config: { maxConcurrency: 2, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	});
	for (const input of tasks) {
		store.createTask(id, {
			id: input.id,
			title: input.id,
			description: `work on ${input.id}`,
			agent: "backend",
			status: input.status,
			depends: input.depends ?? [],
			created: store.now(),
			started: input.status === "pending" ? null : store.now(),
			completed: input.status === "done" ? store.now() : null,
			output: input.status === "done" ? `${input.id} original output` : null,
			error: null,
			usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
		});
	}
	return id;
}

function installFakeSpawner(scheduler, squadId) {
	const pool = scheduler.getPool();
	const spawns = [];
	const prompts = [];
	pool.spawn = async (options) => {
		spawns.push(options);
		const session = options.resumeSession ?? {
			file: path.join(options.sessionDir, `${options.taskId}.jsonl`),
			sessionId: `session-${options.taskId}`,
		};
		const process = { exitCode: null, stdin: { destroyed: false, write: () => true }, kill: () => true };
		const agent = {
			taskId: options.taskId,
			agentName: options.agentDef.name,
			process,
			activity: {
				taskId: options.taskId,
				agentName: options.agentDef.name,
				lastOutputTs: Date.now(),
				startedAt: Date.now(),
				turnCount: 0,
				recentToolCalls: [],
				modifiedFiles: new Set(),
			},
			session,
			aborted: false,
		};
		pool.agents.set(options.taskId, agent);
		return agent;
	};
	pool.prompt = async (taskId, message) => {
		prompts.push({ taskId, message });
		return true;
	};
	scheduler.monitor.start = () => {};
	return { pool, spawns, prompts };
}

test("live task steering is durably task-addressed and acknowledged without same-role leakage", async () => {
	const id = createSquad([
		{ id: "api", status: "in_progress" },
		{ id: "worker", status: "pending" },
	]);
	const scheduler = new Scheduler(id, []);
	const pool = scheduler.getPool();
	const writes = [];
	let acceptRpc = true;
	let agent;
	agent = {
		taskId: "api",
		agentName: "backend",
		process: {
			exitCode: null,
			stdin: {
				destroyed: false,
				write: (data) => {
					writes.push(data.toString());
					const command = JSON.parse(data.toString());
					queueMicrotask(() => pool.handleRpcEvent(agent, {
						type: "response",
						id: command.id,
						command: command.type,
						success: acceptRpc,
					}));
					return true;
				},
			},
			kill: () => true,
		},
		activity: { taskId: "api", agentName: "backend", lastOutputTs: Date.now(), startedAt: Date.now(), turnCount: 0, recentToolCalls: [], modifiedFiles: new Set() },
		session: { file: path.join(tempHome, "api.jsonl") },
		aborted: false,
	};
	pool.agents.set("api", agent);

	assert.equal(await scheduler.sendHumanMessage("api", "keep the entire payload"), true);
	assert.equal(writes.length, 1);
	assert.equal(store.loadPendingTaskMessages(id, "api").length, 0);
	assert.equal(store.loadTaskMailbox(id, "api").length, 1);
	assert.deepEqual(store.loadTaskMailbox(id, "worker"), []);
	assert.equal(store.loadMessages(id, "api").filter((message) => message.from === "orchestrator").length, 1);

	acceptRpc = false;
	assert.equal(await scheduler.sendHumanMessage("api", "retain until Pi accepts"), false);
	assert.equal(store.loadPendingTaskMessages(id, "api").length, 1, "rejected RPC must remain pending on disk");
	assert.equal(store.loadTask(id, "api").status, "in_progress", "a still-live task must remain in_progress");
	assert.deepEqual(store.loadTaskMailbox(id, "worker"), []);

	pool.handleRpcEvent(agent, { type: "agent_settled" });
	assert.equal(store.loadTask(id, "api").status, "pending", "pending durable mail prevents settled completion");
});

test("a completed task reopens on its original session while a new task alone gets a new session", async () => {
	const id = createSquad([
		{ id: "existing", status: "done" },
		{ id: "brand-new", status: "pending" },
	], "review");
	const originalFile = path.join(store.getTaskSessionDir(id, "existing"), "original.jsonl");
	store.bindTaskSession(id, "existing", { file: originalFile, sessionId: "original-session" });
	const scheduler = new Scheduler(id, []);
	const { spawns } = installFakeSpawner(scheduler, id);
	scheduler.running = true;

	assert.equal(await scheduler.sendHumanMessage("existing", "reopen this exact task"), true);
	const resumed = spawns.find((spawn) => spawn.taskId === "existing");
	const created = spawns.find((spawn) => spawn.taskId === "brand-new");
	assert.deepEqual(resumed.resumeSession, { file: originalFile, sessionId: "original-session" });
	assert.equal(resumed.sessionDir, undefined);
	assert.equal(created.resumeSession, undefined);
	assert.equal(created.sessionDir, store.getTaskSessionDir(id, "brand-new"));
	assert.equal(store.loadTaskSession(id, "existing").file, originalFile);
	assert.equal(store.loadTask(id, "existing").status, "in_progress");
	assert.equal(store.loadSquad(id).status, "running");
});

test("message-reopened live task treats redundant resume as an idempotent no-op and settles once", async () => {
	const id = createSquad([{ id: "reopen-live", status: "done" }], "review");
	const originalFile = path.join(store.getTaskSessionDir(id, "reopen-live"), "original.jsonl");
	store.bindTaskSession(id, "reopen-live", { file: originalFile, sessionId: "original-session" });
	const scheduler = new Scheduler(id, []);
	const { pool, spawns } = installFakeSpawner(scheduler, id);
	scheduler.running = true;

	assert.equal(await scheduler.sendHumanMessage("reopen-live", "perform exact rework"), true);
	assert.equal(store.loadTask(id, "reopen-live").status, "in_progress");
	assert.equal(spawns.length, 1);
	const sessionBefore = store.loadTaskSession(id, "reopen-live");

	assert.equal(await scheduler.resumeTask("reopen-live"), "already_running");
	assert.equal(store.loadTask(id, "reopen-live").status, "in_progress");
	assert.equal(spawns.length, 1, "redundant resume must not spawn a second child");
	assert.deepEqual(store.loadTaskSession(id, "reopen-live"), sessionBefore);

	const agent = pool.agents.get("reopen-live");
	agent.activity.turnCount = 1;
	agent.activity.recentToolCalls.push({ name: "read", ts: Date.now() });
	pool.handleRpcEvent(agent, { type: "agent_settled" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(store.loadTask(id, "reopen-live").status, "done");
	assert.equal(store.loadSquad(id).status, "review");
	assert.equal(spawns.length, 1, "one settlement must produce one completion without a duplicate run");
});

test("late settlement and exit callbacks cannot overwrite an explicit task pause", async () => {
	const id = createSquad([{ id: "pause-live", status: "in_progress" }]);
	const scheduler = new Scheduler(id, []);
	const pool = scheduler.getPool();
	const agent = {
		taskId: "pause-live",
		agentName: "backend",
		process: { exitCode: null, stdin: { destroyed: false, write: () => true }, kill: () => true },
		activity: { taskId: "pause-live", agentName: "backend", lastOutputTs: Date.now(), startedAt: Date.now(), turnCount: 1, recentToolCalls: [], modifiedFiles: new Set() },
		session: { file: path.join(tempHome, "pause-live.jsonl") },
		aborted: false,
	};
	pool.agents.set("pause-live", agent);
	pool.steer = async () => true;
	pool.kill = async () => { pool.agents.delete("pause-live"); };

	await scheduler.pauseTask("pause-live");
	assert.equal(store.loadTask(id, "pause-live").status, "suspended");
	pool.handleRpcEvent(agent, { type: "agent_settled", data: { turnCount: 1, toolCallCount: 1 } });
	scheduler.handleAgentEvent({
		type: "agent_end", taskId: "pause-live", agentName: "backend",
		data: { unexpectedExit: true, exitCode: 1, turnCount: 1, stderr: "paused child exit" },
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(store.loadTask(id, "pause-live").status, "suspended");
	assert.equal(store.loadTask(id, "pause-live").error, null);
});

test("mail queued before scheduler restart is delivered to only that task and then acknowledged", async () => {
	const id = createSquad([
		{ id: "first", status: "done" },
		{ id: "second", status: "done" },
	], "review");
	const firstFile = path.join(store.getTaskSessionDir(id, "first"), "first.jsonl");
	const secondFile = path.join(store.getTaskSessionDir(id, "second"), "second.jsonl");
	store.bindTaskSession(id, "first", { file: firstFile });
	store.bindTaskSession(id, "second", { file: secondFile });

	// Simulate a process stop immediately after the mailbox-first durable write,
	// before sendHumanMessage can mutate task/squad state or deliver RPC.
	store.queueTaskMessage(id, "first", {
		ts: store.now(),
		from: "orchestrator",
		type: "message",
		text: "survive restart MESSAGE-END",
		expectsReply: true,
	});
	assert.equal(store.loadTask(id, "first").status, "done");
	assert.equal(store.loadSquad(id).status, "review");
	assert.equal(store.loadPendingTaskMessages(id, "first").length, 1);
	assert.equal(store.loadPendingTaskMessages(id, "second").length, 0);

	const reconstructed = new Scheduler(id, []);
	const { spawns, prompts } = installFakeSpawner(reconstructed, id);
	await reconstructed.start();

	assert.deepEqual(spawns.map((spawn) => spawn.taskId), ["first"]);
	assert.equal(spawns[0].resumeSession.file, firstFile);
	assert.ok(prompts[0].message.includes("survive restart MESSAGE-END"));
	assert.equal(store.loadPendingTaskMessages(id, "first").length, 0);
	assert.equal(store.loadTask(id, "second").status, "done");
});

test("stale callbacks from a replaced child cannot evict or settle the replacement", () => {
	const id = createSquad([{ id: "replace-me", status: "in_progress" }]);
	const scheduler = new Scheduler(id, []);
	const pool = scheduler.getPool();
	const events = [];
	pool.onEvent((event) => events.push(event));
	const makeAgent = (label) => {
		const kills = [];
		const process = {
			exitCode: null,
			stdin: { destroyed: false, write: () => true },
			kill: (signal) => { kills.push(signal); return true; },
		};
		return {
			kills,
			agent: {
				taskId: "replace-me",
				agentName: "backend",
				process,
				activity: { taskId: "replace-me", agentName: "backend", lastOutputTs: Date.now(), startedAt: Date.now(), turnCount: 1, recentToolCalls: [], modifiedFiles: new Set() },
				session: { file: path.join(tempHome, `${label}.jsonl`) },
				aborted: false,
			},
		};
	};
	const oldChild = makeAgent("old");
	const replacement = makeAgent("replacement");
	pool.agents.set("replace-me", replacement.agent);

	pool.handleRpcEvent(oldChild.agent, { type: "agent_settled" });

	assert.equal(pool.isRunning("replace-me"), true, "the replacement remains registered and live");
	assert.deepEqual(replacement.kills, [], "stale settlement must not kill the replacement");
	assert.deepEqual(oldChild.kills, [], "an already-replaced child callback is ignored");
	assert.equal(events.length, 0, "stale settlement must not reach the scheduler");
});

test("a stale old-child exit callback cannot remove its already-installed replacement", async () => {
	const id = createSquad([{ id: "late-exit", status: "in_progress" }]);
	const task = store.loadTask(id, "late-exit");
	const squad = store.loadSquad(id);
	const binDir = fs.mkdtempSync(path.join(tempHome, "late-exit-bin-"));
	const fakePi = path.join(binDir, "pi");
	fs.writeFileSync(fakePi, `#!/usr/bin/env node
const path = require("node:path");
const args = process.argv.slice(2);
const dir = args[args.indexOf("--session-dir") + 1];
let buffer = "";
process.stdin.on("data", (chunk) => {
 buffer += chunk;
 const lines = buffer.split("\\n"); buffer = lines.pop() || "";
 for (const line of lines) { if (!line) continue; const command = JSON.parse(line);
  if (command.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile: path.join(dir, "late-exit.jsonl"), sessionId: "late-exit-id" } }) + "\\n");
 }
});
process.on("SIGTERM", () => process.exit(0));
`);
	fs.chmodSync(fakePi, 0o755);
	const oldPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
	try {
		const scheduler = new Scheduler(id, []);
		const pool = scheduler.getPool();
		const events = [];
		pool.onEvent((event) => events.push(event));
		const oldChild = await pool.spawn({
			taskId: task.id,
			agentDef: store.loadAgentDef("backend", squad.cwd),
			protocolOptions: { squadId: id, squad, task, agentDef: store.loadAgentDef("backend", squad.cwd), modifiedFiles: {}, queuedMessages: [] },
			cwd: tempHome,
			skillPaths: [],
			sessionDir: store.getTaskSessionDir(id, task.id),
		});
		const replacement = {
			...oldChild,
			process: { exitCode: null, stdin: { destroyed: false, write: () => true }, kill: () => true },
			session: { file: path.join(tempHome, "replacement-late-exit.jsonl") },
		};
		pool.agents.set(task.id, replacement);
		const exited = new Promise((resolve) => oldChild.process.once("exit", resolve));
		oldChild.process.kill("SIGTERM");
		await exited;
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(pool.agents.get(task.id), replacement, "old proc.on(exit) must use child identity, not only task ID");
		assert.equal(pool.isRunning(task.id), true);
		assert.equal(events.length, 0, "stale old-child exit must not emit an unexpected task lifecycle event");
	} finally {
		process.env.PATH = oldPath;
	}
});

test("reopening a completed dependency recursively revalidates every completed descendant", async () => {
	const id = createSquad([
		{ id: "contract", status: "done" },
		{ id: "implementation", status: "done", depends: ["contract"] },
		{ id: "qa", status: "done", depends: ["implementation"] },
		{ id: "release", status: "done", depends: ["qa"] },
	], "review");
	for (const taskId of ["contract", "implementation", "qa", "release"]) {
		store.bindTaskSession(id, taskId, { file: path.join(store.getTaskSessionDir(id, taskId), `${taskId}.jsonl`) });
	}
	const scheduler = new Scheduler(id, []);
	const { pool, spawns } = installFakeSpawner(scheduler, id);
	scheduler.running = true;

	assert.equal(await scheduler.sendHumanMessage("contract", "revise the root contract"), true);
	assert.equal(store.loadTask(id, "contract").status, "in_progress");
	for (const taskId of ["implementation", "qa", "release"]) {
		const task = store.loadTask(id, taskId);
		assert.equal(task.status, "blocked", `${taskId} must be invalidated transitively`);
		assert.equal(task.completed, null, `${taskId} completion timestamp must be cleared`);
	}
	assert.deepEqual(spawns.map((spawn) => spawn.taskId), ["contract"], "only the reopened root runs first");

	pool.agents.delete("contract");
	store.appendMessage(id, "contract", { ts: store.now(), from: "backend", type: "text", text: "revised contract" });
	await scheduler.handleTaskCompleted("contract");
	assert.equal(store.loadTask(id, "implementation").status, "in_progress", "direct descendant reruns after root settles");
	assert.equal(store.loadTask(id, "qa").status, "blocked");

	pool.agents.delete("implementation");
	store.appendMessage(id, "implementation", { ts: store.now(), from: "backend", type: "text", text: "revised implementation" });
	await scheduler.handleTaskCompleted("implementation");
	assert.equal(store.loadTask(id, "qa").status, "in_progress", "second-level descendant reruns next");
	assert.equal(store.loadTask(id, "release").status, "blocked");
});

test("a legacy task without a binding seeds its new durable session with complete multiline history", async () => {
	const id = createSquad([{ id: "legacy", status: "done" }], "review");
	const first = `LEGACY-FIRST\n${"alpha\n".repeat(1200)}FIRST-END`;
	const second = `LEGACY-SECOND\n${"βeta\n".repeat(1200)}SECOND-END`;
	const legacy = store.loadTask(id, "legacy");
	legacy.output = `LEGACY-OUTPUT\n${"result\n".repeat(1200)}OUTPUT-END`;
	store.saveTask(id, legacy);
	store.appendMessage(id, "legacy", { ts: "2026-07-16T09:00:00.000Z", from: "backend", type: "text", text: first });
	store.appendMessage(id, "legacy", { ts: "2026-07-16T09:00:01.000Z", from: "orchestrator", type: "message", text: second });

	const scheduler = new Scheduler(id, []);
	const { prompts, spawns } = installFakeSpawner(scheduler, id);
	scheduler.running = true;
	assert.equal(await scheduler.sendHumanMessage("legacy", "NEW-MIGRATION-REQUEST\nREQUEST-END"), true);

	assert.equal(spawns[0].resumeSession, undefined, "legacy task has no old Pi session to resume");
	assert.equal(spawns[0].sessionDir, store.getTaskSessionDir(id, "legacy"));
	assert.ok(store.loadTaskSession(id, "legacy"), "migration binds the newly created durable session");
	const seed = prompts[0].message;
	assert.ok(seed.includes(first), "first multiline legacy message is seeded without truncation");
	assert.ok(seed.includes(second), "second multiline legacy message is seeded without truncation");
	assert.ok(seed.includes(legacy.output), "legacy task output is seeded without truncation");
	assert.ok(seed.includes("NEW-MIGRATION-REQUEST\nREQUEST-END"), "new pending request is included in the same seed");
	assert.ok(seed.indexOf(first) < seed.indexOf(second), "legacy history remains chronological");
});

test("task remains in_progress through low-level end and completes only after agent_settled", async () => {
	const id = createSquad([{ id: "settle", status: "in_progress" }]);
	const scheduler = new Scheduler(id, []);
	const report = "final durable output";
	scheduler.handleAgentEvent({
		type: "message_end",
		taskId: "settle",
		agentName: "backend",
		data: { role: "assistant", content: [{ type: "text", text: report }] },
	});
	scheduler.handleAgentEvent({
		type: "agent_end",
		taskId: "settle",
		agentName: "backend",
		data: { exitCode: 0, turnCount: 1, toolCallCount: 0, stderr: "" },
	});
	assert.equal(store.loadTask(id, "settle").status, "in_progress");

	scheduler.handleAgentEvent({
		type: "agent_settled",
		taskId: "settle",
		agentName: "backend",
		data: { exitCode: 0, turnCount: 1, toolCallCount: 0, stderr: "" },
	});
	for (let i = 0; i < 50 && store.loadTask(id, "settle").status !== "done"; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(store.loadTask(id, "settle").status, "done");
	assert.equal(store.loadTask(id, "settle").output, report);
});
