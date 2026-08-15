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

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-handoff-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const store = await import("../src/store.ts");
const { buildAgentSystemPrompt } = await import("../src/protocol.ts");
const { Router } = await import("../src/router.ts");

function saveSquad(id, agents = { architect: {}, backend: {}, qa: {} }) {
	const squad = {
		id,
		goal: "test complete dependency handoffs",
		status: "running",
		created: store.now(),
		cwd: tempHome,
		agents,
		config: { maxConcurrency: 2, autoUnblock: true, reviewOnComplete: true, maxRetries: 2 },
	};
	store.saveSquad(squad);
	return squad;
}

function saveTask(squadId, { id, agent, status, depends = [], output = null }) {
	const task = {
		id,
		title: id,
		description: `Context: Depend on ${depends.map((d) => `\`${d}\``).join(", ")}. Verify: inspect complete outputs.`,
		agent,
		status,
		depends,
		created: store.now(),
		started: null,
		completed: status === "done" ? store.now() : null,
		output,
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
	};
	store.createTask(squadId, task);
	return task;
}

test("downstream prompt includes complete transitive dependency outputs once, ancestors first", () => {
	const id = "sq-transitive";
	const squad = saveSquad(id);
	const architectOutput = `ARCHITECT-START\n${"a".repeat(5000)}\nARCHITECT-END`;
	const backendOutput = `BACKEND-START\n${"b".repeat(5000)}\nBACKEND-END`;
	saveTask(id, { id: "contract", agent: "architect", status: "done", output: architectOutput });
	saveTask(id, { id: "implementation", agent: "backend", status: "done", depends: ["contract"], output: backendOutput });
	const qa = saveTask(id, { id: "qa", agent: "qa", status: "pending", depends: ["implementation"] });

	const prompt = buildAgentSystemPrompt({
		squadId: id,
		squad,
		task: qa,
		agentDef: { name: "qa", role: "QA", description: "test", model: null, tools: null, tags: [], prompt: "Review all ancestors." },
		modifiedFiles: {},
		queuedMessages: [],
	});

	assert.ok(prompt.includes(architectOutput), "transitive architect output must be injected in full");
	assert.ok(prompt.includes(backendOutput), "direct backend output must be injected in full");
	assert.ok(prompt.indexOf(architectOutput) < prompt.indexOf(backendOutput), "ancestors must precede consumers");
	assert.equal(prompt.split("ARCHITECT-START").length - 1, 1, "diamond/ancestor outputs must not duplicate");
});

test("mentioning a completed agent immediately returns its durable output and suppresses escalation", () => {
	const id = "sq-completed-mention";
	saveSquad(id);
	const output = `AUTHORITATIVE-CONTRACT\n${"z".repeat(6000)}\nCONTRACT-END`;
	saveTask(id, { id: "contract", agent: "architect", status: "done", output });
	saveTask(id, { id: "qa", agent: "qa", status: "in_progress" });
	store.saveAgentDef({ name: "architect", role: "Architect", description: "design", model: null, tools: null, tags: [], prompt: "" });
	store.saveAgentDef({ name: "qa", role: "QA", description: "test", model: null, tools: null, tags: [], prompt: "" });

	const steers = [];
	const pool = {
		getTaskIdForAgent: () => null,
		isRunning: (taskId) => taskId === "qa",
		steer: async (taskId, message) => { steers.push({ taskId, message }); return true; },
	};
	const router = new Router(pool, id);
	const escalations = [];
	router.onEscalation((_taskId, _agent, message) => escalations.push(message));

	router.processMessage("qa", "qa", "@architect Please send the completed contract; I am waiting for your input.");

	assert.equal(steers.length, 1);
	assert.equal(steers[0].taskId, "qa");
	assert.ok(steers[0].message.includes(output), "source agent must receive the complete durable output");
	assert.equal(escalations.length, 0, "an immediately resolved completed-output request is not a human blocker");
	const replies = store.loadMessages(id, "qa").filter((message) => message.type === "reply");
	assert.equal(replies.length, 1);
	assert.ok(replies[0].text.includes("CONTRACT-END"));
});

test("concurrent writers receive worktree isolation guidance; solo tasks do not", () => {
	const id = "sq-worktree-guidance";
	const squad = saveSquad(id, { backend: {}, frontend: {} });
	const mine = saveTask(id, { id: "api", agent: "backend", status: "pending", depends: [] });
	saveTask(id, { id: "ui", agent: "frontend", status: "in_progress", depends: [] });

	const prompt = buildAgentSystemPrompt({
		squadId: id,
		squad,
		task: mine,
		agentDef: { name: "backend", role: "Backend", description: "impl", model: null, tools: null, tags: [], prompt: "Build." },
		modifiedFiles: { frontend: ["src/app.tsx"] },
		queuedMessages: [],
	});
	assert.ok(prompt.includes("Use a Git Worktree"), "concurrent writers get worktree guidance");
	assert.ok(prompt.includes("git worktree add"), "guidance includes the exact command shape");
	assert.ok(prompt.includes("squad/<your-task-id>"), "guidance names the branch convention");
	assert.ok(prompt.includes("git worktree remove"), "cleanup contract is part of the guidance");
	assert.ok(prompt.includes("Read-only tasks"), "read-only tasks are exempted");

	// A squad with no concurrent activity and no foreign modified files stays lean.
	const soloId = "sq-worktree-solo";
	const soloSquad = saveSquad(soloId, { backend: {} });
	const solo = saveTask(soloId, { id: "only", agent: "backend", status: "pending", depends: [] });
	const soloPrompt = buildAgentSystemPrompt({
		squadId: soloId,
		squad: soloSquad,
		task: solo,
		agentDef: { name: "backend", role: "Backend", description: "impl", model: null, tools: null, tags: [], prompt: "Build." },
		modifiedFiles: {},
		queuedMessages: [],
	});
	assert.ok(!soloPrompt.includes("Use a Git Worktree"), "solo tasks are not pushed into worktrees");
});
