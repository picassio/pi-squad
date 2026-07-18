import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chunkRanges, type PreparedSpec } from "./file-spec.js";
import { logError } from "./logger.js";
import { validatePlan } from "./plan-rules.js";
import { runPlanner } from "./planner.js";
import { Scheduler } from "./scheduler.js";
import { wireSchedulerEvents } from "./scheduler-runtime.js";
import * as store from "./store.js";
import type { PlannerOutput, Squad, SquadAgentEntry, SquadConfig, Task } from "./types.js";
import { DEFAULT_SQUAD_CONFIG } from "./types.js";
import { disabledToolResult, focusSquad, resolveSquadDefaults, runtime, schedulerSpawnContext, type InlineSquadStart } from "./runtime.js";

// ============================================================================
// Start Squad
// ============================================================================

export async function startSquad(
	squadId: string,
	params: InlineSquadStart,
	cwd: string,
	skillPaths: string[],
	pi: ExtensionAPI,
	sessionFile: string | null = null,
	preparedSpec?: PreparedSpec,
) {
	let plan: PlannerOutput;

	if (params.tasks && params.tasks.length > 0) {
		// User provided a plan — use it directly
		plan = {
			agents: params.agents || {},
			tasks: params.tasks.map((t) => ({
				...t,
				description: t.description || "",
				depends: t.depends || [],
			})),
		};

		// Validate agent names — remap unknown agents to fullstack
		for (const task of plan.tasks) {
			const agentDef = store.loadAgentDef(task.agent, cwd);
			if (!agentDef || agentDef.disabled) {
				if (preparedSpec) throw new Error(`SPEC_MALFORMED: assigned agent '${task.agent}' is missing or disabled`);
				const original = task.agent;
				task.agent = "fullstack";
				task.description = `[Note: agent "${original}" not found, remapped to fullstack]\n\n${task.description}`;
			}
		}
	} else {
		// Run planner to generate task breakdown (squad default policy as fallback)
		try {
			const defaults = resolveSquadDefaults();
			plan = await runPlanner({ goal: params.goal, cwd, fallbackModel: defaults.model, fallbackThinking: defaults.thinking });
		} catch (error) {
			// Throwing marks the tool result as an error for the LLM (returning isError is ignored in current pi)
			throw new Error(`Failed to plan: ${(error as Error).message}`);
		}
	}

	// A planner may take long enough for /squad disable to run concurrently.
	// Re-check before publishing any squad or constructing a scheduler.
	if (!runtime.squadEnabled) return disabledToolResult();

	// Merge agent roster
	const agents: Record<string, SquadAgentEntry> = { ...plan.agents };
	if (params.agents) {
		for (const [name, entry] of Object.entries(params.agents)) {
			agents[name] = { ...agents[name], ...entry };
		}
	}

	// Validate the plan — same enforcement for main-session and planner plans.
	// Errors block squad creation; warnings are reported back to the plan author.
	const validation = validatePlan(plan.tasks);
	if (validation.errors.length > 0) {
		throw new Error(
			`Plan rejected:\n- ${validation.errors.join("\n- ")}\n\nFix the task list and call squad again.`,
		);
	}

	// Create squad
	const config: SquadConfig = {
		...DEFAULT_SQUAD_CONFIG,
		...(params.config?.maxConcurrency ? { maxConcurrency: params.config.maxConcurrency } : {}),
		...(typeof params.config?.autoUnblock === "boolean" ? { autoUnblock: params.config.autoUnblock } : {}),
		...(typeof params.config?.maxRetries === "number" ? { maxRetries: params.config.maxRetries } : {}),
	};

	const squad: Squad = {
		id: squadId,
		goal: params.goal,
		status: "running",
		created: store.now(),
		cwd,
		sessionFile,
		agents,
		config,
		...(preparedSpec ? { spec: {
			schemaVersion: 1 as const,
			sha256: preparedSpec.sha256,
			bytes: preparedSpec.raw.length,
			path: path.join(store.getSquadDir(squadId), "spec", "spec.v1.json"),
			chunkBytes: 32768 as const,
			chunkCount: chunkRanges(preparedSpec.raw).length,
		} } : {}),
	};

	// Materialize task state in memory so file squads can publish spec+squad+tasks atomically.
	const initialTasks: Task[] = plan.tasks.map((taskDef) => {
		const task: Task = {
			id: taskDef.id,
			title: taskDef.title,
			description: taskDef.description,
			agent: taskDef.agent,
			status: taskDef.depends.length === 0 ? "pending" : "blocked",
			depends: taskDef.depends,
			...(taskDef.inheritContext ? { inheritContext: true } : {}),
			created: store.now(),
			started: null,
			completed: null,
			output: null,
			error: null,
			usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
		};
		return task;
	});

	if (preparedSpec) store.publishFileSquad(squad, initialTasks, preparedSpec.raw);
	else {
		store.saveSquad(squad);
		for (const task of initialTasks) store.createTask(squadId, task);
	}

	// Start scheduler
	const scheduler = new Scheduler(squadId, skillPaths, schedulerSpawnContext);
	runtime.schedulers.set(squadId, scheduler);
	// Activate panel/widget/tool focus as one invariant.
	focusSquad(squadId);

	// Wire up completion/escalation notifications to main agent.
	wireSchedulerEvents(pi, scheduler, squadId);

	// Start scheduling — fire and forget, don't block the tool call.
	// scheduler.start() spawns agents which can take seconds per agent.
	// We must return immediately so the main agent's turn completes
	// and the user regains interactive control.
	scheduler.start().catch((err) => {
		logError("squad", `Scheduler start error: ${(err as Error).message}`);
	});

	// Build response. File mode returns only the bounded descriptor; the canonical
	// contract is never reflected back into the main model's transport.
	const taskSummary = preparedSpec
		? `Canonical spec: ${squad.spec!.path}\nSHA-256: ${squad.spec!.sha256}\nBytes: ${squad.spec!.bytes}\nTasks: ${plan.tasks.length}`
		: plan.tasks
			.map((t) => {
				const deps = t.depends.length > 0 ? ` (depends: ${t.depends.join(", ")})` : "";
				return `${t.id} → ${t.agent}: ${t.title}${deps}`;
			})
			.join("\n");

	return {
		content: [
			{
				type: "text" as const,
				text: `Squad "${squadId}" started with ${plan.tasks.length} tasks.\n\n${taskSummary}${
					validation.warnings.length > 0
						? `\n\n⚠️ Plan warnings (fix with squad_modify, or address at review):\n- ${validation.warnings.join("\n- ")}`
						: ""
				}\n\nAgents work in the background — you will be woken automatically when the squad completes, fails, or needs help. Report this plan to the user and END YOUR TURN now. Do NOT poll squad_status, do NOT sleep-wait, do NOT loop.`,
			},
		],
		details: undefined,
	};
}
