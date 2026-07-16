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

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-steer-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { AgentPool } = await import("../src/agent-pool.ts");
const { Scheduler } = await import("../src/scheduler.ts");
const store = await import("../src/store.ts");

function attachFakeRunningAgent(pool, taskId = "qa-task", agentName = "qa") {
	const writes = [];
	const kills = [];
	let agent;
	const process = {
		stdin: {
			destroyed: false,
			write: (data) => {
				writes.push(data.toString());
				const command = JSON.parse(data.toString());
				if (command.id) {
					queueMicrotask(() => pool.handleRpcEvent(agent, {
						type: "response",
						id: command.id,
						command: command.type,
						success: true,
					}));
				}
				return true;
			},
		},
		exitCode: null,
		killed: false,
		kill: (signal) => { kills.push(signal); process.killed = true; return true; },
	};
	agent = {
		taskId,
		agentName,
		process,
		activity: {
			taskId,
			agentName,
			lastOutputTs: Date.now(),
			startedAt: Date.now(),
			turnCount: 0,
			recentToolCalls: [],
			modifiedFiles: new Set(),
		},
		session: { file: path.join(tempHome, `${taskId}.jsonl`) },
		aborted: false,
	};
	pool.agents.set(taskId, agent);
	return { agent, writes, kills };
}

test("main-session steer writes the documented Pi RPC command exactly", async () => {
	const pool = new AgentPool();
	const { writes } = attachFakeRunningAgent(pool);
	assert.equal(pool.getTaskIdForAgent("qa"), "qa-task");

	const sent = await pool.steer("qa-task", "[squad] Main orchestrator: use the completed contract");
	assert.equal(sent, true);
	assert.equal(writes.length, 1);
	const command = JSON.parse(writes[0]);
	assert.equal(typeof command.id, "string", "delivery acknowledgement must be correlated");
	delete command.id;
	assert.deepEqual(command, {
		type: "steer",
		message: "[squad] Main orchestrator: use the completed contract",
	});
	assert.ok(writes[0].endsWith("\n"), "RPC framing must be JSONL/LF");
});

test("scheduler main-session message persists fully and steers the live task", async () => {
	const id = "sq-main-steer";
	store.saveSquad({
		id,
		goal: "verify main steering",
		status: "running",
		created: store.now(),
		cwd: tempHome,
		agents: { qa: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	});
	store.createTask(id, {
		id: "qa-task",
		title: "QA",
		description: "Verify steering",
		agent: "qa",
		status: "in_progress",
		depends: [],
		created: store.now(),
		started: store.now(),
		completed: null,
		output: null,
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
	});
	const scheduler = new Scheduler(id, []);
	const pool = scheduler.getPool();
	const { writes } = attachFakeRunningAgent(pool);
	const events = [];
	scheduler.onEvent((event) => events.push(event));
	const message = `Use the complete contract\n${"detail\n".repeat(1000)}MESSAGE-END`;

	assert.equal(pool.getTaskIdForAgent("qa"), "qa-task", "agent-name targeting resolves to live task");
	assert.equal(await scheduler.sendHumanMessage("qa-task", message), true);
	const command = JSON.parse(writes[0]);
	assert.equal(command.type, "steer");
	assert.equal(typeof command.id, "string");
	assert.ok(command.message.startsWith("[squad] Main orchestrator requests a direct response:"));
	assert.ok(command.message.includes(message));
	assert.match(command.message, /forwarded automatically to the main session/);
	const durable = store.loadMessages(id, "qa-task").at(-1);
	assert.equal(durable.from, "orchestrator");
	assert.equal(durable.expectsReply, true);
	assert.equal(durable.text, message, "main message is persisted without truncation");

	const reply = `STATUS\n${"result\n".repeat(1000)}REPLY-END`;
	scheduler.handleAgentEvent({
		type: "message_end",
		taskId: "qa-task",
		agentName: "qa",
		data: { role: "assistant", content: [{ type: "text", text: reply }] },
	});
	const forwarded = events.filter((event) => event.type === "orchestrator_reply");
	assert.equal(forwarded.length, 1);
	assert.equal(forwarded[0].message, reply, "complete response must be pushed back without truncation");
	assert.ok(store.loadMessages(id, "qa-task").some((entry) => entry.type === "reply" && entry.to === "orchestrator"));

	// Further normal activity is panel-only until main asks another question.
	scheduler.handleAgentEvent({
		type: "message_end",
		taskId: "qa-task",
		agentName: "qa",
		data: { role: "assistant", content: [{ type: "text", text: "later activity" }] },
	});
	assert.equal(events.filter((event) => event.type === "orchestrator_reply").length, 1);

	assert.equal(await scheduler.sendHumanMessage("qa-task", "fire-and-forget correction", false), true);
	const correction = JSON.parse(writes[1]);
	assert.equal(typeof correction.id, "string");
	delete correction.id;
	assert.deepEqual(correction, { type: "steer", message: "[squad] Main orchestrator message:\nfire-and-forget correction" });
	scheduler.handleAgentEvent({
		type: "message_end",
		taskId: "qa-task",
		agentName: "qa",
		data: { role: "assistant", content: [{ type: "text", text: "acknowledged correction" }] },
	});
	assert.equal(events.filter((event) => event.type === "orchestrator_reply").length, 1, "fire-and-forget must not wake main");
	pool.agents.delete("qa-task");
});

test("pending orchestrator reply survives scheduler reconstruction", async () => {
	const id = "sq-reply-restart";
	store.saveSquad({
		id,
		goal: "persist reply request",
		status: "running",
		created: store.now(),
		cwd: tempHome,
		agents: { qa: {} },
		config: { maxConcurrency: 1, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	});
	store.createTask(id, {
		id: "qa-restart",
		title: "QA",
		description: "Reply later",
		agent: "qa",
		status: "pending",
		depends: [],
		created: store.now(),
		started: null,
		completed: null,
		output: null,
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
	});
	const first = new Scheduler(id, []);
	assert.equal(await first.sendHumanMessage("qa-restart", "status after start"), false, "non-running task queues request");

	const reconstructed = new Scheduler(id, []);
	const events = [];
	reconstructed.onEvent((event) => events.push(event));
	reconstructed.handleAgentEvent({
		type: "message_end",
		taskId: "qa-restart",
		agentName: "qa",
		data: { role: "assistant", content: [{ type: "text", text: "reconstructed reply" }] },
	});
	assert.equal(events.filter((event) => event.type === "orchestrator_reply").length, 1);
	assert.equal(events.find((event) => event.type === "orchestrator_reply").message, "reconstructed reply");
});

test("agent_end does not kill queued steer; only agent_settled finalizes the child", () => {
	const pool = new AgentPool();
	const { agent, kills } = attachFakeRunningAgent(pool);
	const events = [];
	pool.onEvent((event) => events.push(event));

	pool.handleRpcEvent(agent, { type: "agent_end", messages: [], willRetry: false });
	assert.equal(pool.isRunning("qa-task"), true, "agent_end is low-level and steer continuations may remain");
	assert.deepEqual(kills, []);
	assert.equal(events.filter((event) => event.type === "agent_settled").length, 0);

	pool.handleRpcEvent(agent, { type: "agent_settled" });
	assert.equal(pool.isRunning("qa-task"), false);
	assert.deepEqual(kills, ["SIGTERM"]);
	assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
});

test("steer reports false when child stdin is unavailable", async () => {
	const pool = new AgentPool();
	const { agent, writes } = attachFakeRunningAgent(pool);
	agent.process.stdin.destroyed = true;
	assert.equal(await pool.steer("qa-task", "message"), false);
	assert.deepEqual(writes, []);
});
