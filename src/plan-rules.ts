/**
 * plan-rules.ts — Single source of truth for squad planning behavior.
 *
 * Used by BOTH planning paths so they behave identically:
 * - The planner agent (planner.ts injects these into its prompt)
 * - The main pi session (index.ts injects these into the squad tool
 *   description / hint, and validatePlan() enforces them at submission)
 */

// ============================================================================
// Shared prompt fragments
// ============================================================================

/** How to structure task descriptions (Goal/Context/Output/Boundaries/Verify) */
export const TASK_DESCRIPTION_GUIDE = `Structure each task description around these parts (include only the parts that help):
- **Goal**: the outcome, stated first. Describe the result, not step-by-step process — prescribe steps only when the process itself matters
- **Context**: the specific files, contracts, or dependency outputs the agent should read — name where to look, don't dump everything
- **Output**: the expected deliverable — files, format, level of detail
- **Boundaries**: what must stay unchanged (public APIs, schemas, config), what the agent must not do, and anything requiring escalation instead of guessing
- **Verify**: the exact command or check that proves the task is done (e.g. "npm test -- auth", "curl /api/health returns 200")`;

/** Structural rules for a good plan */
export const PLAN_STRUCTURE_RULES = `- Task IDs must be short kebab-case (e.g., "setup-db", "auth-middleware")
- Dependencies must reference task IDs from the same plan
- First task(s) should have empty depends: []
- When tasks share an interface (API endpoints, database schema, data formats), create a design/contract task first that defines the contract, and make consuming tasks depend on it
- Include a final QA/verification task if there are user-facing changes
- Don't over-decompose — 3-7 tasks is usually right for most goals
- Scope tasks to required work only — no optional polish or nice-to-haves unless the goal asks for them`;

// ============================================================================
// Plan validation (enforcement — applies to planner AND main-session plans)
// ============================================================================

export interface PlanTaskInput {
	id: string;
	title: string;
	description: string;
	agent: string;
	depends: string[];
}

export interface PlanValidation {
	/** Hard failures — squad must not start */
	errors: string[];
	/** Rule violations worth reporting back to the plan author */
	warnings: string[];
}

/** Does this task look like a QA/verification/review task? */
function isQaLikeTask(task: PlanTaskInput): boolean {
	const hay = `${task.id} ${task.title} ${task.agent}`.toLowerCase();
	return /\b(qa|test|tests|testing|verif\w*|review|audit)\b/.test(hay);
}

/**
 * Validate a plan's structure. Errors block squad creation;
 * warnings are returned to the plan author for correction.
 */
export function validatePlan(tasks: PlanTaskInput[]): PlanValidation {
	const errors: string[] = [];
	const warnings: string[] = [];

	// Duplicate IDs
	const ids = new Set<string>();
	for (const t of tasks) {
		if (ids.has(t.id)) errors.push(`Duplicate task id: "${t.id}"`);
		ids.add(t.id);
	}

	// Unknown dependency references
	for (const t of tasks) {
		for (const dep of t.depends) {
			if (!ids.has(dep)) {
				errors.push(`Task "${t.id}" depends on unknown task "${dep}"`);
			}
		}
	}

	// Cycle detection (DFS, only over known deps)
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const inCycle: string[] = [];
	const visit = (id: string): boolean => {
		if (visited.has(id)) return false;
		if (visiting.has(id)) return true;
		visiting.add(id);
		const task = byId.get(id);
		if (task) {
			for (const dep of task.depends) {
				if (byId.has(dep) && visit(dep)) {
					inCycle.push(id);
					visiting.delete(id);
					return true;
				}
			}
		}
		visiting.delete(id);
		visited.add(id);
		return false;
	};
	for (const t of tasks) {
		if (visit(t.id) && inCycle.length > 0) {
			errors.push(`Dependency cycle involving: ${[...new Set(inCycle)].join(", ")}`);
			break;
		}
	}

	// No entry point (every task has deps) — only meaningful without errors
	if (tasks.length > 0 && errors.length === 0 && !tasks.some((t) => t.depends.length === 0)) {
		errors.push("No task has empty depends — nothing can start");
	}

	// --- Warnings (planner rules) ---

	if (tasks.length > 9) {
		warnings.push(`${tasks.length} tasks — over-decomposed (3-7 is usually right). Consider merging related tasks.`);
	}

	if (tasks.length >= 3 && !tasks.some(isQaLikeTask)) {
		warnings.push("No QA/verification task in the plan. Add a final task that tests the integrated result, or verify it yourself when the squad completes.");
	}

	for (const t of tasks) {
		if (!t.description || t.description.trim().length === 0) {
			warnings.push(`Task "${t.id}" has no description — the agent only gets the title.`);
		} else if (!/verif|test|check|curl|run\b|npm |pnpm |cargo |pytest|tsc\b/i.test(t.description)) {
			warnings.push(`Task "${t.id}" description has no Verify criterion — the agent won't know how to prove it's done.`);
		}
	}

	return { errors, warnings };
}
