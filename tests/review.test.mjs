import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

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

const {
	beginOrchestratorReview,
	beginOrchestratorRework,
	buildOrchestratorReviewGate,
	recordOrchestratorReview,
} = await import("../src/review.ts");

function squad() {
	return {
		id: "sq-review",
		goal: "Original outcome: production login works and all auth tests pass",
		status: "running",
		created: "2026-07-15T00:00:00.000Z",
		cwd: "/tmp/project",
		agents: {},
		config: { maxConcurrency: 2, autoUnblock: true, reviewOnComplete: true, maxRetries: 2 },
	};
}

const evidence = {
	verdict: "pass",
	contractChecks: ["Login flow: independently exercised and passed", "Auth suite: 42/42 passed"],
	diffReview: "Inspected git diff and auth/router consumers; no unrelated changes.",
	verificationEvidence: ["npm test -- auth → 42 passed, 0 failed", "npm run build → exit 0"],
	integrationEvidence: "Production-like E2E login → protected route → logout passed.",
	issues: [],
};

test("agent completion enters a persistent mandatory review gate", () => {
	const value = squad();
	beginOrchestratorReview(value);
	assert.equal(value.status, "review");
	assert.equal(value.review.status, "pending");
	assert.equal(value.review.verdict, null);
});

test("review gate names the original contract as authoritative and distrusts squad QA", () => {
	const value = squad();
	beginOrchestratorReview(value);
	const gate = buildOrchestratorReviewGate(value, [{
		id: "qa",
		title: "QA auth",
		description: "Verify: npm test -- auth",
		agent: "qa",
		status: "done",
		depends: [],
		created: value.created,
		started: null,
		completed: null,
		output: "PASS",
		error: null,
		usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
	}]);
	assert.match(gate, /ORIGINAL request/);
	assert.match(gate, /Squad QA PASS does not override/);
	assert.match(gate, /Do not ask the user whether you should verify/);
	assert.ok(gate.includes(value.goal));
});

test("file-spec review gate references exact durable bytes without reinlining the large contract", () => {
	const value = squad();
	value.goal = "SECRET_LARGE_GOAL";
	value.spec = { schemaVersion: 1, sha256: "a".repeat(64), bytes: 500000, path: "/tmp/sq-review/spec/spec.v1.json", chunkBytes: 32768, chunkCount: 16 };
	beginOrchestratorReview(value);
	const gate = buildOrchestratorReviewGate(value, [{
		id: "qa", title: "SECRET_TASK_TITLE", description: "SECRET_LARGE_DESCRIPTION", agent: "qa", status: "done", depends: [], created: value.created, started: null, completed: null, output: null, error: null, usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
	}]);
	assert.match(gate, /\/tmp\/sq-review\/spec\/spec\.v1\.json/);
	assert.match(gate, /sha256=a{64}/);
	assert.doesNotMatch(gate, /SECRET_LARGE_GOAL|SECRET_TASK_TITLE|SECRET_LARGE_DESCRIPTION/);
});

test("only evidence-backed orchestrator pass changes review to done", () => {
	const value = squad();
	beginOrchestratorReview(value);
	assert.throws(() => recordOrchestratorReview(value, { ...evidence, verificationEvidence: [] }), /verificationEvidence/);
	assert.equal(value.status, "review");

	recordOrchestratorReview(value, evidence);
	assert.equal(value.status, "done");
	assert.equal(value.review.status, "passed");
	assert.equal(value.review.verdict, "pass");
	assert.deepEqual(value.review.verificationEvidence, evidence.verificationEvidence);
});

test("failed review evidence moves to history when same-squad rework starts", () => {
	const value = squad();
	beginOrchestratorReview(value);
	recordOrchestratorReview(value, {
		...evidence,
		verdict: "fail",
		issues: ["Production E2E exposed an invalid cookie domain"],
	});
	const failedAttempt = value.review;

	beginOrchestratorRework(value);
	assert.equal(value.status, "running");
	assert.equal(value.review, undefined);
	assert.deepEqual(value.reviewHistory, [failedAttempt]);

	beginOrchestratorReview(value);
	assert.equal(value.status, "review");
	assert.equal(value.review.status, "pending", "fresh attempt is the only active gate");
	assert.deepEqual(value.reviewHistory, [failedAttempt], "prior evidence remains immutable history");
});

test("accepting an unrelated squad cannot resolve another squad's failed gate", () => {
	const failed = squad();
	failed.id = "sq-authoritative-failed";
	beginOrchestratorReview(failed);
	recordOrchestratorReview(failed, {
		...evidence,
		verdict: "fail",
		issues: ["Authoritative squad still needs rework"],
	});

	const unrelated = squad();
	unrelated.id = "sq-unrelated-remediation";
	beginOrchestratorReview(unrelated);
	recordOrchestratorReview(unrelated, evidence);

	assert.equal(unrelated.status, "done");
	assert.equal(failed.status, "review");
	assert.equal(failed.review.status, "failed");
	assert.equal(failed.reviewHistory, undefined);
});

test("failed independent review remains gated until fixes and re-review", () => {
	const value = squad();
	beginOrchestratorReview(value);
	recordOrchestratorReview(value, {
		...evidence,
		verdict: "fail",
		issues: ["Production E2E exposed an invalid cookie domain"],
	});
	assert.equal(value.status, "review");
	assert.equal(value.review.status, "failed");
	const gate = buildOrchestratorReviewGate(value, []);
	assert.match(gate, /✗ REVIEW FAILED · awaiting same-squad rework/);
	assert.match(gate, new RegExp(`same exact squad.*squadId: "${value.id}"`));
	assert.match(gate, /another verdict cannot overwrite the failed evidence/);
	assert.throws(
		() => recordOrchestratorReview(value, evidence),
		/already failed; begin same-squad rework/,
		"a failed attempt cannot be overwritten by a pass without settled rework and a fresh pending gate",
	);
});
