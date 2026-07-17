import * as path from "node:path";
import type { Squad, Task } from "./types.js";

export type OrchestratorReviewVerdict = "pass" | "pass_with_issues" | "fail";

export interface OrchestratorReviewInput {
	verdict: OrchestratorReviewVerdict;
	contractChecks: string[];
	diffReview: string;
	verificationEvidence: string[];
	integrationEvidence: string;
	issues: string[];
}

/**
 * Start same-squad rework without discarding completed review evidence.
 * The next all-tasks-done transition creates a new active pending review.
 */
export function beginOrchestratorRework(squad: Squad): void {
	if (squad.review && squad.review.status !== "pending") {
		squad.reviewHistory = [...(squad.reviewHistory ?? []), { ...squad.review }];
	}
	delete squad.review;
	squad.status = "running";
}

/** Move a squad from agent execution into mandatory independent main-session review. */
export function beginOrchestratorReview(squad: Squad): void {
	squad.status = "review";
	squad.review = {
		status: "pending",
		requestedAt: new Date().toISOString(),
		completedAt: null,
		verdict: null,
		contractChecks: [],
		diffReview: "",
		verificationEvidence: [],
		integrationEvidence: "",
		issues: [],
	};
}

/**
 * Validate and record the orchestrator's independent review evidence.
 * A failing review deliberately leaves the squad behind the review gate.
 */
export function recordOrchestratorReview(squad: Squad, input: OrchestratorReviewInput): void {
	if (squad.status !== "review" || !squad.review) {
		throw new Error(`Squad '${squad.id}' is not awaiting orchestrator review`);
	}
	if (squad.review.status !== "pending") {
		throw new Error(`Squad '${squad.id}' review attempt is already ${squad.review.status}; begin same-squad rework before submitting a fresh review`);
	}

	const contractChecks = cleanList(input.contractChecks);
	const verificationEvidence = cleanList(input.verificationEvidence);
	const issues = cleanList(input.issues);
	const diffReview = input.diffReview.trim();
	const integrationEvidence = input.integrationEvidence.trim();

	if (contractChecks.length === 0) {
		throw new Error("contractChecks must map the original user requirements to observed results");
	}
	if (!diffReview) {
		throw new Error("diffReview must describe the independently inspected changes and scope");
	}
	if (verificationEvidence.length === 0) {
		throw new Error("verificationEvidence must include commands/checks and their actual results");
	}
	if (!integrationEvidence) {
		throw new Error("integrationEvidence must include E2E/integration results or a specific reason it is not applicable");
	}
	if ((input.verdict === "fail" || input.verdict === "pass_with_issues") && issues.length === 0) {
		throw new Error(`${input.verdict} must list every actionable or remaining issue`);
	}

	squad.review = {
		status: input.verdict === "fail" ? "failed" : "passed",
		requestedAt: squad.review.requestedAt,
		completedAt: new Date().toISOString(),
		verdict: input.verdict,
		contractChecks,
		diffReview,
		verificationEvidence,
		integrationEvidence,
		issues,
	};

	// Only an independently reviewed PASS can become done. A FAIL remains gated
	// until fixes are made and the main orchestrator records a fresh review.
	squad.status = input.verdict === "fail" ? "review" : "done";
}

/** Persistent system-prompt contract shown until squad_review accepts the work. */
export function buildOrchestratorReviewGate(squad: Squad, tasks: Task[]): string {
	const failed = squad.review?.status === "failed";
	const reviewLabel = failed
		? "✗ REVIEW FAILED · awaiting same-squad rework"
		: "◆ REVIEW PENDING · independent review required";
	const reviewAction = failed
		? `This candidate was rejected. Do not submit another verdict yet. Start concrete rework in this same exact squad with squad_modify and squadId: "${squad.id}"; the failed evidence remains immutable history. After rework settles, a fresh REVIEW PENDING gate will require a new independent review.`
		: `This candidate is awaiting its first verdict. Complete the checks below, then call squad_review for squadId: "${squad.id}".`;
	const goalReference = squad.spec
		? `Canonical file spec at ${squad.spec.path} (sha256=${squad.spec.sha256}, bytes=${squad.spec.bytes}). Read and hash the exact file during review; its contract is intentionally not duplicated into this prompt.`
		: squad.goal;
	const delegatedPlan = squad.spec
		? tasks.map((task) => `- ${task.id} (${task.agent}) [${task.status}] — task state: ${path.join(path.dirname(path.dirname(squad.spec!.path)), task.id, "task.json")}`).join("\n")
		: tasks.map((task) => `- ${task.id} (${task.agent}): ${task.title}\n  ${task.description || "(no description)"}`).join("\n");

	return `<squad_review_required>
UNTRUSTED CANDIDATE WORK — INDEPENDENT ORCHESTRATOR REVIEW IS MANDATORY.

Authoritative contract: re-read the user's ORIGINAL request and all later clarifications in this main-session conversation. The squad report and delegated task descriptions are claims, not proof and not substitutes for that contract.
Recorded squad goal (secondary reference): ${goalReference}
Acceptance: ${reviewLabel}
${reviewAction}

Delegated plan (non-authoritative):
${delegatedPlan}

Before reporting success, completion, or acceptance to the user, YOU (the main Pi/orchestrator) MUST:
1. Reconstruct the original contract requirement-by-requirement from the conversation.
2. Inspect the actual working-tree/commit diff and relevant source files yourself; check scope, integration points, error paths, regressions, and unintended changes.
3. Independently run the original Verify commands and appropriate build/tests. Do not rely on pasted squad output.
4. Run integration/E2E in the real target or production-like environment when the request affects runtime behavior. If genuinely not applicable or impossible, record the precise reason and mark it unverified.
5. Fix discovered defects and repeat checks. Squad QA PASS does not override your findings.
6. When the active gate is REVIEW PENDING, call squad_review with contract checks, diff review, actual command/result evidence, integration/E2E evidence, and remaining issues. When it is REVIEW FAILED, route same-squad rework first; another verdict cannot overwrite the failed evidence.

Do not ask the user whether you should verify. Do not merely summarize the squad report. Until fresh rework is independently reviewed and squad_review records PASS/PASS_WITH_ISSUES, the work is not accepted.
</squad_review_required>`;
}

function cleanList(values: string[]): string[] {
	return values.map((value) => value.trim()).filter(Boolean);
}
