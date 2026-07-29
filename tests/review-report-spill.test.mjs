import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Map ./x.js → ./x.ts for src imports (Node type stripping doesn't rewrite).
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js")) {
			try {
				return nextResolve(specifier, context);
			} catch {
				return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
			}
		}
		return nextResolve(specifier, context);
	},
});

// Isolate squad storage (~/.pi/squad) in a temp HOME before importing store.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-squad-review-spill-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const store = await import("../src/store.ts");
const { buildReviewRequiredNotification, reviewInlineLimit } = await import("../src/report.ts");
const { buildOrchestratorReviewGate } = await import("../src/review.ts");

let squadCounter = 0;

function makeSquad(taskSpecs) {
	const id = `sq-spill-${++squadCounter}`;
	const cwd = fs.mkdtempSync(path.join(tempHome, "proj-"));
	const squad = {
		id, goal: "large squad review delivery", status: "review", created: store.now(), cwd,
		agents: { backend: {} },
		config: { maxConcurrency: 2, autoUnblock: true, reviewOnComplete: true, maxRetries: 1 },
	};
	store.saveSquad(squad);
	for (const spec of taskSpecs) {
		store.createTask(id, {
			id: spec.id, title: spec.title ?? `Task ${spec.id}`, description: spec.description ?? "",
			agent: "backend", status: spec.status ?? "done", depends: [],
			created: store.now(), started: store.now(), completed: store.now(),
			output: spec.output ?? null, error: spec.error ?? null,
			usage: { inputTokens: 0, outputTokens: 0, cost: spec.cost ?? 0.5, turns: 3 },
		});
	}
	return { id, squad: store.loadSquad(id) };
}

test("small squads keep the fully inline review report (no file, no digest)", () => {
	const { id, squad } = makeSquad([
		{ id: "impl", output: "IMPL-START full handoff body IMPL-END" },
		{ id: "qa", output: "QA-START evidence QA-END" },
	]);
	const tasks = store.loadAllTasks(id);
	const result = buildReviewRequiredNotification(squad, tasks);
	assert.equal(result.reportPath, null, "small report stays inline");
	assert.ok(result.content.includes("IMPL-START full handoff body IMPL-END"));
	assert.ok(result.content.includes("QA-START evidence QA-END"));
	assert.ok(!fs.existsSync(path.join(store.getSquadDir(id), "review-report.md")));
});

test("an 89-task squad spills the complete report to a durable file and delivers a bounded digest", () => {
	const specs = Array.from({ length: 89 }, (_, i) => {
		const id = `task-${String(i + 1).padStart(2, "0")}`;
		return {
			id,
			description: `Detailed delegated description for ${id}. ${"ctx ".repeat(60)}`,
			output: `${id.toUpperCase()}-START\n${`handoff-line-${id} `.repeat(150)}\n${id.toUpperCase()}-END`,
		};
	});
	const { id, squad } = makeSquad(specs);
	const tasks = store.loadAllTasks(id);
	const result = buildReviewRequiredNotification(squad, tasks);

	// Spilled: durable file carries every byte of every handoff.
	assert.ok(result.reportPath, "large report must spill to a file");
	const fileBody = fs.readFileSync(result.reportPath, "utf8");
	for (const task of tasks) {
		assert.ok(fileBody.includes(task.output), `file is missing the full output of ${task.id}`);
		assert.ok(fileBody.includes(`${task.id.toUpperCase()}-END`), `file is missing the tail of ${task.id}`);
	}

	// Digest: bounded, complete index, mandatory-read pointer, no handoff bodies.
	assert.ok(result.content.length < reviewInlineLimit() + 10_000,
		`digest must stay bounded (got ${result.content.length} chars)`);
	assert.ok(result.content.includes(result.reportPath), "digest must point at the report file");
	assert.match(result.content, /MANDATORY: read that ENTIRE file/);
	for (const task of tasks) {
		assert.ok(result.content.includes(`- ${task.id} (backend)`), `digest index missing ${task.id}`);
		assert.ok(!result.content.includes(`${task.id.toUpperCase()}-START`), `digest must not inline ${task.id} handoff`);
	}
	// Gate in the digest uses durable task.json pointers, not inlined descriptions.
	assert.match(result.content, /full title\/description\/state: .*task-01.*task\.json/);
	assert.ok(!result.content.includes("Detailed delegated description for task-01"));
	// The review contract itself must remain intact in the digest.
	assert.match(result.content, /<squad_review_required>/);
	assert.match(result.content, /INDEPENDENT ORCHESTRATOR REVIEW IS MANDATORY/);
});

test("PI_SQUAD_REVIEW_INLINE_LIMIT overrides the spill threshold", () => {
	process.env.PI_SQUAD_REVIEW_INLINE_LIMIT = "1000";
	try {
		const { id, squad } = makeSquad([{ id: "impl", output: `IMPL ${"x".repeat(2_000)}` }]);
		const result = buildReviewRequiredNotification(squad, store.loadAllTasks(id));
		assert.ok(result.reportPath, "lowered limit forces the spill path");
		assert.ok(fs.readFileSync(result.reportPath, "utf8").includes("x".repeat(2_000)));
	} finally {
		delete process.env.PI_SQUAD_REVIEW_INLINE_LIMIT;
	}
});

test("the review gate auto-compacts oversized delegated plans into durable pointers", () => {
	const bigSpecs = Array.from({ length: 60 }, (_, i) => ({
		id: `plan-${i}`,
		description: `Plan description ${i} ${"detail ".repeat(50)}`,
		status: "done",
	}));
	const { id, squad } = makeSquad(bigSpecs);
	const gate = buildOrchestratorReviewGate(squad, store.loadAllTasks(id));
	assert.ok(!gate.includes("Plan description 0"), "oversized plan must not inline descriptions");
	assert.match(gate, /plan-0 \(backend\) \[done\] — full title\/description\/state: .*task\.json/);

	const { id: smallId, squad: smallSquad } = makeSquad([{ id: "only", description: "Small inline description" }]);
	const smallGate = buildOrchestratorReviewGate(smallSquad, store.loadAllTasks(smallId));
	assert.ok(smallGate.includes("Small inline description"), "small plans keep full inline descriptions");
});
