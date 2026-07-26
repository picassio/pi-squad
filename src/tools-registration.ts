import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { prepareSpec, isFileSpecTaskId, type PreparedSpec } from "./file-spec.js";
import { coerceInlineSquadStart } from "./inline-input.js";
import { PLAN_STRUCTURE_RULES } from "./plan-rules.js";
import { formatSuspendedAttention, getReviewPresentation } from "./presentation.js";
import { buildOrchestratorReviewGate, recordOrchestratorReview } from "./review.js";
import { formatSuspendedStallAttention } from "./scheduler.js";
import { cancelExactSquad, ensureScheduler, reviveScheduler } from "./scheduler-runtime.js";
import { startSquad } from "./start-squad.js";
import * as store from "./store.js";
import type { Task } from "./types.js";
import { activeSuspendedAttentionForProject, disabledToolResult, focusSquad, forceWidgetUpdate, formatTaskProgress, getActiveScheduler, resolveResumeSquad, runtime, type InlineSquadStart } from "./runtime.js";

export function registerTools(pi: ExtensionAPI, squadSkillPaths: string[]): void {
// =========================================================================
// Context Injection — give main agent awareness of squad state
// =========================================================================

// Inject squad awareness before each LLM call
pi.on("before_agent_start", async (event, ctx) => {
	// Review gates are project-wide and survive focus changes, new squads, and
	// disabling normal squad operations. Unaccepted work must stay visible.
	const pendingReviewGates = store.findActiveSquads()
		.filter((s) => s.cwd === ctx.cwd && s.status === "review")
		.map((s) => ({ squad: s, gate: buildOrchestratorReviewGate(s, store.loadAllTasks(s.id)) }));
	const suspendedAttention = activeSuspendedAttentionForProject(ctx.cwd)
		.map(({ squadId, attention }) => formatSuspendedStallAttention(squadId, attention));
	const durablePrompts = [...pendingReviewGates.map(({ gate }) => gate), ...suspendedAttention];
	if (!runtime.squadEnabled) {
		if (durablePrompts.length === 0) return;
		const enableFirst = durablePrompts.map((prompt) =>
			`${prompt}\npi-squad is disabled. Run /squad enable first; then perform only the explicit review or exact-task resume described above.`,
		);
		return { systemPrompt: event.systemPrompt + "\n\n" + enableFirst.join("\n\n") };
	}

	// When a squad is active, inject its status
	if (runtime.activeSquadId) {
		const squad = store.loadSquad(runtime.activeSquadId);
		if (!squad) {
			focusSquad(null);
			if (durablePrompts.length > 0) {
				return { systemPrompt: event.systemPrompt + "\n\n" + durablePrompts.join("\n\n") };
			}
			return;
		}
		const tasks = store.loadAllTasks(runtime.activeSquadId);
		if (tasks.length === 0) {
			if (durablePrompts.length > 0) {
				return { systemPrompt: event.systemPrompt + "\n\n" + durablePrompts.join("\n\n") };
			}
			return;
		}

		const totalCost = tasks.reduce((sum, t) => sum + t.usage.cost, 0);

		const taskLines = tasks.map((t) => {
			const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "⏳" : t.status === "failed" ? "✗" : t.status === "blocked" ? "◻" : t.status === "suspended" ? "⏸" : t.status === "cancelled" ? "⊘" : "·";
			let line = `  ${icon} ${t.id} (${t.agent}) [${t.status}]`;
			if (t.output) line += ` — ${t.output}`;
			if (t.error) line += ` ERROR: ${t.error}`;
			return line;
		}).join("\n");

		const reviewPresentation = getReviewPresentation(squad);
		const squadReference = squad.spec
			? `file spec sha256=${squad.spec.sha256} bytes=${squad.spec.bytes} path=${squad.spec.path}`
			: squad.goal;
		const squadContext = [
			`<squad_status>`,
			`Squad: ${squad.id} — ${squadReference}`,
			`Status: ${squad.status} | ${formatTaskProgress(tasks)} | $${totalCost.toFixed(2)}`,
			...(reviewPresentation ? [`Acceptance: ${reviewPresentation.label}`] : []),
			taskLines,
			`</squad_status>`,
			...(squad.status === "review" ? [buildOrchestratorReviewGate(squad, tasks)] : []),
			...pendingReviewGates.filter(({ squad: pending }) => pending.id !== squad.id).map(({ gate }) => gate),
			...suspendedAttention,
			`You have an active squad. Use squad_message to talk to agents, squad_status for details, squad_modify to change tasks.`,
			`Do NOT poll squad_status in a loop or sleep-wait — the squad wakes you automatically on completion, failure, or escalation. Keep helping the user with other work, or end your turn and stay idle.`,
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + "\n\n" + squadContext,
		};
	}

	// When NO squad is active, nudge the agent to consider using squad for complex tasks
	const allAgents = store.loadAllAgentDefs(ctx.cwd).filter((a) => a.name !== "planner" && !a.disabled);
	const agentList = allAgents.map((a) => `${a.name} (${a.role})`).join(", ");
	const squadNudge = [
		`<squad_hint>`,
		`You have the "squad" tool available for multi-agent collaboration.`,
		`Use it when the user's request involves multiple concerns (e.g. backend + frontend + tests + docs),`,
		`would benefit from parallel execution, or is too large for a single agent context.`,
		`The squad tool decomposes work into tasks, assigns specialist agents, and runs them in parallel.`,
		`When in doubt about whether a task is complex enough, prefer using squad — it handles the coordination for you.`,
		allAgents.length > 0 ? `Available agents: ${agentList}. When providing tasks, the "agent" field must be one of these names.` : ``,
		`When you provide tasks yourself, you take the planner's role — follow its rules: contract/design task first for shared interfaces, final QA task for user-facing changes, 3-7 tasks, first task(s) with empty depends.`,
		`Structure descriptions as: Goal (outcome first), Context (files to read), Output (deliverable), Boundaries (what must not change), Verify (proving command).`,
		`</squad_hint>`,
	].filter(Boolean).join("\n");

	return {
		systemPrompt: event.systemPrompt + "\n\n" + squadNudge +
			(durablePrompts.length > 0 ? "\n\n" + durablePrompts.join("\n\n") : ""),
	};
});

// =========================================================================
// Tool: squad
// =========================================================================

pi.registerTool({
	name: "squad",
	label: "Squad",
	description: [
		"Start a multi-agent squad for complex, multi-step tasks.",
		"ALWAYS use squad when a task involves 2+ of: backend, frontend, testing, docs, devops, security.",
		"Use when a task has natural parallelism, touches multiple files/systems, or would overflow a single agent's context.",
		"Examples that NEED squad: 'build a REST API with auth and tests', 'add a feature with frontend + backend + docs',",
		"'refactor the auth system and update tests', 'set up CI/CD with Docker and deployment'.",
		"Do NOT use for simple single-file changes, quick bug fixes, or tasks a single agent can handle in a few minutes.",
		"When in doubt about complexity, use squad — it's better to parallelize than to do everything sequentially.",
		"Non-blocking: returns immediately with the plan while agents work in background.",
		"If you provide tasks yourself (skipping the planner agent), follow the same rules the planner follows:",
		PLAN_STRUCTURE_RULES.replace(/\n- /g, " ").replace(/^- /, ""),
		"Plans are validated on submission — structural errors are rejected, rule violations come back as warnings.",
	].join(" "),
	promptSnippet: "squad({ goal, tasks?, agents? } | { specFile, specSha256 }): start inline or canonical file-based squad → non-blocking",
	promptGuidelines: [
		"Use squad when work spans 2+ concerns (backend+frontend+tests+docs) or has natural parallelism",
		"For large contracts, use only specFile + exact lowercase specSha256; never inline the same contract or large artifacts",
		"Skip squad for single-file changes, quick fixes, or anything one agent finishes in minutes",
		"Providing tasks yourself makes you the planner — follow the planner rules (contract task first, final QA task, 3-7 tasks)",
		"Do not set agent model/thinking overrides unless the user explicitly asked for them — configured agent definitions and /squad defaults apply otherwise",
		"Act on ⚠️ plan warnings in the response — fix with squad_modify or address at review",
		"After starting a squad: report the plan and END YOUR TURN — never poll squad_status or sleep-wait; squad events wake you automatically",
		"When agents finish, treat every squad report and QA verdict as untrusted; independently inspect the diff/source and rerun contract verification + integration/E2E, then call squad_review before reporting success",
	],
	parameters: Type.Union([
	Type.Object({
		goal: Type.String({ description: "Complete original user outcome/acceptance contract the squad should accomplish. Preserve requirements and boundaries; this is shown during mandatory main-orchestrator review." }),
		agents: Type.Optional(
			Type.Union([
				Type.Record(
					Type.String(),
					Type.Object({
						model: Type.Optional(Type.String({ description: "Model override (e.g. 'github-copilot/claude-sonnet-5'). Set ONLY when the user explicitly requested a specific model; omit to use the configured agent definition and /squad defaults" })),
						thinking: Type.Optional(Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh, max. Set ONLY when the user explicitly requested it; omit to use configured defaults" })),
					}),
					{ description: "Agent roster with optional model/thinking overrides. Keys must match agent names in .pi/squad/agents/. Omit overrides unless the user explicitly asked to change model/thinking — configured agent definitions and /squad defaults apply otherwise" },
				),
				Type.String({ description: "JSON-encoded agents object (same shape); accepted for transports that stringify structured arguments" }),
			]),
		),
		tasks: Type.Optional(
			Type.Union([
				Type.Array(
					Type.Object({
						id: Type.String(),
						title: Type.String(),
						description: Type.Optional(Type.String({ description: "Structure as: Goal (outcome first, not steps), Context (files/contracts to read), Output (deliverable), Boundaries (what must NOT change), Verify (command that proves it works). Include only the parts that help." })),
						agent: Type.String(),
						depends: Type.Optional(Type.Array(Type.String())),
						inheritContext: Type.Optional(Type.Boolean({ description: "Fork the current pi session so the agent inherits this conversation's full context. Use ONLY when the task depends on decisions/details discussed here that can't be restated briefly. Costly (agent pays the whole history as input each turn) and auto-skipped when the session exceeds 50% of the agent model's context window — prefer restating key context in the description." })),
					}),
					{ description: "Pre-defined task breakdown. If provided, skips the planner agent. Scope tasks to required work only — no optional polish." },
				),
				Type.String({ description: "JSON-encoded tasks array (same item shape); accepted for transports that stringify structured arguments" }),
			]),
		),
		config: Type.Optional(
			Type.Union([
				Type.Object({
					maxConcurrency: Type.Optional(Type.Number({ description: "Max parallel agents (default: 2)" })),
				}),
				Type.String({ description: "JSON-encoded config object (same shape); accepted for transports that stringify structured arguments" }),
			]),
		),
	}, { additionalProperties: false }),
	Type.Object({
		specFile: Type.String({ minLength: 1, description: "Path to a strict v1 squad specification JSON file" }),
		specSha256: Type.String({ pattern: "^[a-f0-9]{64}$", description: "SHA-256 of the exact source bytes" }),
	}, { additionalProperties: false }),
	]),

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		if (!runtime.squadEnabled) return disabledToolResult();
		if (!runtime.uiCtx) runtime.uiCtx = ctx;

		// Check if the user cancelled before we start
		if (signal?.aborted) return { content: [{ type: "text" as const, text: "Cancelled." }], details: undefined };

		// Multiple squads can run concurrently — no guard needed

		// Resolve to absolute: the fork happens later from a child process whose
		// cwd may differ (e.g. when a relative --session-dir was used).
		const rawSessionFile = ctx.sessionManager.getSessionFile();
		const sessionFile = rawSessionFile ? path.resolve(rawSessionFile) : null;
		let prepared: PreparedSpec | undefined;
		let effective: InlineSquadStart;
		if ("specFile" in params) {
			prepared = prepareSpec(params.specFile, params.specSha256, ctx.cwd);
			effective = { goal: prepared.spec.goal, agents: prepared.spec.agents, tasks: prepared.spec.tasks, config: prepared.spec.config };
		} else {
			// Some transports stringify structured arguments; decode tolerantly with
			// precise errors instead of failing a correct plan on transport shape.
			const coerced = coerceInlineSquadStart(params);
			if (!coerced.ok) {
				return { content: [{ type: "text" as const, text: `Invalid squad input: ${coerced.error} No squad was started.` }], details: undefined };
			}
			effective = coerced.value;
		}
		const baseId = store.makeSquadId(effective.goal);
		const squadId = store.squadExists(baseId) ? `${baseId}-${Date.now().toString(36)}` : baseId;
		return await startSquad(squadId, effective, ctx.cwd, squadSkillPaths, pi, sessionFile, prepared);
	},
});

// =========================================================================
// Tool: squad_status
// =========================================================================

pi.registerTool({
	name: "squad_status",
	label: "Squad Status",
	description: "Check current squad status, task progress, and recent activity. Do NOT call this in a loop or after sleep-waits — squad completion/failure/escalations wake you automatically. Use only when the user asks for a status update or after being woken by a squad event.",
	parameters: Type.Object({
		squadId: Type.Optional(Type.String({ description: "Specific squad ID (default: most recent)" })),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		if (!runtime.squadEnabled) return disabledToolResult();
		let id = params.squadId || runtime.activeSquadId;

		// If no active squad, find the most recent one for this project
		if (!id) {
			const latest = store.findLatestSquad(ctx.cwd);
			if (latest) id = latest.id;
		}

		if (!id) {
			return { content: [{ type: "text" as const, text: "No squads found. Use the squad tool to start one." }], details: undefined };
		}

		// If scheduler is running, force a context refresh
		const sched = runtime.schedulers.get(id!);
			if (sched) sched.updateContext();

		const context = store.loadContext(id);
		if (!context) {
			return { content: [{ type: "text" as const, text: `Squad '${id}' not found or has no context yet.` }], details: undefined };
		}

		const taskLines = Object.entries(context.tasks)
			.map(([taskId, task]) => {
				const icon =
					task.status === "done" ? "✓" :
					task.status === "in_progress" ? "⏳" :
					task.status === "blocked" ? "◻" :
					task.status === "failed" ? "✗" :
					task.status === "suspended" ? "⏸" :
					task.status === "cancelled" ? "⊘" :
					"·";
				let line = `${icon} ${taskId} (${task.agent}) — ${task.title} [${task.status}]`;
				if (task.blockedBy?.length) line += ` blocked by: ${task.blockedBy.join(", ")}`;
				return line;
			})
			.join("\n");

		const durableTasks = store.loadAllTasks(id!);
		const squad = store.loadSquad(id!);
		const review = squad ? getReviewPresentation(squad) : null;
		const summary = [
			`Squad: ${id}`,
			`Status: ${context.status}`,
			`Progress: ${formatTaskProgress(durableTasks)}`,
			`Elapsed: ${context.elapsed}`,
			`Cost: $${context.costs.total.toFixed(4)}`,
			...(review ? [`Acceptance: ${review.label}`] : []),
			...(squad ? formatSuspendedAttention(squad) : []),
			"",
			"Tasks:",
			taskLines,
		].join("\n");

		return { content: [{ type: "text" as const, text: summary }], details: undefined };
	},
});

// =========================================================================
// Tool: squad_review — mandatory main-orchestrator acceptance gate
// =========================================================================

pi.registerTool({
	name: "squad_review",
	label: "Record Independent Squad Review",
	description: "Record the MAIN Pi/orchestrator's independent review of completed squad work against the original user contract. Call only after inspecting the actual diff/source and independently running verification plus integration/E2E where applicable. Squad reports and squad QA evidence are not sufficient.",
	parameters: Type.Object({
		squadId: Type.Optional(Type.String({ description: "Squad awaiting review (default: active/latest)" })),
		verdict: Type.Union([
			Type.Literal("pass"),
			Type.Literal("pass_with_issues"),
			Type.Literal("fail"),
		]),
		contractChecks: Type.Array(Type.String(), { minItems: 1, description: "Requirement-by-requirement checks against the ORIGINAL user request and later clarifications; include observed result for each" }),
		diffReview: Type.String({ description: "What you independently inspected in the actual diff/source, including scope and integration concerns" }),
		verificationEvidence: Type.Array(Type.String(), { minItems: 1, description: "Commands/checks YOU ran and their actual results; do not copy squad claims" }),
		integrationEvidence: Type.String({ description: "Integration/E2E result from the real target or production-like environment, or a precise reason it is not applicable/impossible and therefore unverified" }),
		issues: Type.Array(Type.String(), { description: "Every discovered or remaining issue; required for fail/pass_with_issues" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		if (!runtime.squadEnabled) return disabledToolResult();
		let id = params.squadId;
		if (!id && runtime.activeSquadId && store.loadSquad(runtime.activeSquadId)?.status === "review") {
			id = runtime.activeSquadId;
		}
		if (!id) {
			id = store.listSquadsForProject(ctx.cwd)
				.filter((s) => s.status === "review")
				.sort((a, b) => b.created.localeCompare(a.created))[0]?.id;
		}
		if (!id) {
			return { content: [{ type: "text" as const, text: "No squad is awaiting orchestrator review." }], details: undefined };
		}

		const squad = store.loadSquad(id);
		if (!squad) {
			return { content: [{ type: "text" as const, text: `Squad '${id}' not found.` }], details: undefined };
		}
		const attestationScheduler = reviveScheduler(pi, id, squadSkillPaths);
		const invalidAttestations = await attestationScheduler.auditSpecAttestations();
		if (!runtime.squadEnabled) return disabledToolResult();
		if (invalidAttestations.length > 0) {
			void attestationScheduler.start();
			return { content: [{ type: "text" as const, text: `Review rejected: invalid canonical spec attestation for task(s): ${invalidAttestations.join(", ")}. Work was reopened.` }], details: undefined };
		}

		try {
			recordOrchestratorReview(squad, {
				verdict: params.verdict,
				contractChecks: params.contractChecks,
				diffReview: params.diffReview,
				verificationEvidence: params.verificationEvidence,
				integrationEvidence: params.integrationEvidence,
				issues: params.issues,
			});
		} catch (error) {
			return { content: [{ type: "text" as const, text: `Review rejected: ${(error as Error).message}` }], details: undefined };
		}

		store.saveSquad(squad);
		forceWidgetUpdate();
		const accepted = squad.status === "done";
		// An accepted squad needs no further attention: auto-dismiss its widget.
		// Review-pending, review-failed, and failed squads stay visible, and the
		// user can still reselect a done squad explicitly with /squad select.
		if (accepted && runtime.activeSquadId === id) focusSquad(null);
		const text = accepted
			? `Independent orchestrator review recorded for '${id}' (${params.verdict}). The squad is now accepted as done.`
			: `Independent review FAILED for '${id}'. The squad remains review-required — do NOT cancel it, do NOT mark it failed, and do NOT stop here.\n` +
				`Route same-squad rework NOW: squad_modify { action: "add_task", squadId: "${id}", task: { id: "<slice>-fix-1", agent: "<original implementer>", forkFromTask: "<original task id>", title: "...", description: "<the exact failed issues>" } }.\n` +
				`forkFromTask reopens the implementer's full session context so nothing is redone. When rework settles, independently re-verify and submit a fresh squad_review.`;
		return { content: [{ type: "text" as const, text }], details: undefined };
	},
});

// =========================================================================
// Tool: squad_message
// =========================================================================

pi.registerTool({
	name: "squad_message",
	label: "Squad Message",
	description: "Send a durable request to a specific task. Existing tasks reopen their original Pi session; only a currently running task may be selected by agent name.",
	parameters: Type.Object({
		message: Type.String({ description: "Message to send" }),
		taskId: Type.Optional(Type.String({ description: "Target task ID" })),
		agent: Type.Optional(Type.String({ description: "Target agent name" })),
		expectReply: Type.Optional(Type.Boolean({ description: "Forward the agent's next substantive response back to main Pi and wake it (default true)" })),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		if (!runtime.squadEnabled) return disabledToolResult();
		if (!runtime.activeSquadId) {
			return { content: [{ type: "text" as const, text: "No active squad." }], details: undefined };
		}

		let activeScheduler = getActiveScheduler();
		let taskId = params.taskId;

		// Agent name is safe shorthand only when it identifies one live task.
		// Multiple concurrent tasks can share a role, so never guess between them.
		if (!taskId && params.agent && activeScheduler) {
			const liveMatches = store.loadAllTasks(runtime.activeSquadId).filter(
				(task) => task.agent === params.agent && activeScheduler!.getPool().isRunning(task.id),
			);
			if (liveMatches.length === 1) taskId = liveMatches[0].id;
		}

		if (!taskId) {
			return { content: [{ type: "text" as const, text: "Could not determine target task. Provide taskId or an agent name that is currently running." }], details: undefined };
		}
		if (!store.loadTask(runtime.activeSquadId, taskId)) {
			return { content: [{ type: "text" as const, text: `Task not found: ${taskId}` }], details: undefined };
		}

		// Review/done squads have no live scheduler after a process restart. An
		// exact task ID is enough to reconstruct it from disk and reopen only that
		// task; the task's immutable session binding supplies --session.
		if (!activeScheduler) {
			activeScheduler = reviveScheduler(pi, runtime.activeSquadId, squadSkillPaths);
			await activeScheduler.start();
		}

		const sent = await activeScheduler.sendHumanMessage(taskId, params.message, params.expectReply ?? true);
		const status = sent ? "delivered" : "queued for when the agent starts";

		return { content: [{ type: "text" as const, text: `Message ${status}: "${params.message}"` }], details: undefined };
	},
});

// =========================================================================
// Tool: squad_modify
// =========================================================================

pi.registerTool({
	name: "squad_modify",
	label: "Squad Modify",
	description: "Modify a squad. The destructive cancel action requires an exact squadId and never infers focus; task actions reconstruct the persisted scheduler after restart when needed.",
	parameters: Type.Object({
		squadId: Type.Optional(Type.String({ description: "Exact squad to modify; required for cancel (other actions may use the focused/recoverable project squad)" })),
		action: Type.Union(
			[
				Type.Literal("add_task"),
				Type.Literal("set_dependencies"),
				Type.Literal("cancel_task"),
				Type.Literal("pause_task"),
				Type.Literal("resume_task"),
				Type.Literal("complete_task"),
				Type.Literal("pause"),
				Type.Literal("resume"),
				Type.Literal("cancel"),
			],
			{ description: "Action to perform" },
		),
		taskId: Type.Optional(Type.String({ description: "Task ID for task-specific actions" })),
		depends: Type.Optional(Type.Array(Type.String(), { description: "Complete replacement dependency list; required at top level for set_dependencies" })),
		output: Type.Optional(Type.String({ description: "Result summary for complete_task (what was accomplished)" })),
		task: Type.Optional(
			Type.Object({
				id: Type.String(),
				title: Type.String(),
				description: Type.Optional(Type.String()),
				agent: Type.String(),
				depends: Type.Optional(Type.Array(Type.String())),
				inheritContext: Type.Optional(Type.Boolean({ description: "Fork the current pi session so the agent inherits this conversation's context (see squad tool docs for caveats)" })),
				forkFromTask: Type.Optional(Type.String({ description: "Existing task ID in this squad whose durable session seeds the new task as a fork — the agent continues with that task's full context instead of redoing everything. Ideal for follow-up and review-rework tasks. Mutually exclusive with inheritContext." })),
			}, { description: "Task definition for add_task" }),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		if (!runtime.squadEnabled) return disabledToolResult();
		if (params.action === "cancel") {
			if (!params.squadId?.trim()) {
				return { content: [{ type: "text" as const, text: "cancel requires exact squadId; no squad was changed." }], details: undefined };
			}
			const squadId = params.squadId.trim();
			if (!store.loadSquad(squadId)) {
				return { content: [{ type: "text" as const, text: `Squad '${squadId}' not found; no squad was changed.` }], details: undefined };
			}
			try {
				await cancelExactSquad(squadId, squadSkillPaths);
			} catch (error) {
				return { content: [{ type: "text" as const, text: `Cancel failed for squad '${squadId}': ${(error as Error).message}` }], details: undefined };
			}
			return { content: [{ type: "text" as const, text: `Squad '${squadId}' cancelled.` }], details: undefined };
		}

		if (params.action === "resume") {
			const squad = resolveResumeSquad(ctx.cwd, params.squadId);
			if (!squad) {
				const text = params.squadId
					? `Squad '${params.squadId}' not found.`
					: "No paused, failed, or failed-review squad found to resume.";
				return { content: [{ type: "text" as const, text }], details: undefined };
			}
			const resumeSched = ensureScheduler(pi, squad.id, squadSkillPaths);
			try {
				await resumeSched.resume();
			} catch (err) {
				return { content: [{ type: "text" as const, text: `Resume failed: ${(err as Error).message}` }], details: undefined };
			}
			const tasks = store.loadAllTasks(squad.id);
			return { content: [{ type: "text" as const, text: `Squad "${squad.id}" resumed (${formatTaskProgress(tasks)}). Agents restarting in background.` }], details: undefined };
		}

		const squadId = params.squadId || runtime.activeSquadId;
		if (!squadId || !store.loadSquad(squadId)) {
			return { content: [{ type: "text" as const, text: params.squadId ? `Squad '${params.squadId}' not found.` : "No active squad. Provide squadId, select the squad, or start a new one." }], details: undefined };
		}
		let activeScheduler = runtime.schedulers.get(squadId) || null;
		if (!activeScheduler && (params.action === "add_task" || params.action === "set_dependencies" || params.action === "cancel_task" || params.action === "resume_task" || params.action === "complete_task" || params.action === "pause_task")) {
			activeScheduler = ensureScheduler(pi, squadId, squadSkillPaths);
		}
		if (!activeScheduler) {
			return { content: [{ type: "text" as const, text: `Squad '${squadId}' has no active scheduler. Use resume, add_task, or resume_task to reconstruct it.` }], details: undefined };
		}
		focusSquad(squadId);

		switch (params.action) {
			case "add_task": {
				if (!params.task) {
					return { content: [{ type: "text" as const, text: "Provide a task definition for add_task." }], details: undefined };
				}
				// Validate against the live squad: deps must exist, agent must exist
				const targetSquad = store.loadSquad(squadId)!;
				if (targetSquad.spec && !isFileSpecTaskId(params.task.id)) {
					return { content: [{ type: "text" as const, text: `Invalid file-spec task id '${params.task.id}'. Use 1..64 lowercase letters/digits with internal hyphens.` }], details: undefined };
				}
				const existing = store.loadAllTasks(squadId);
				const existingIds = new Set(existing.map((t) => t.id));
				if (existingIds.has(params.task.id)) {
					return { content: [{ type: "text" as const, text: `Task id '${params.task.id}' already exists in this squad.` }], details: undefined };
				}
				const badDeps = (params.task.depends || []).filter((d) => !existingIds.has(d));
				if (badDeps.length > 0) {
					return { content: [{ type: "text" as const, text: `Unknown dependency task(s): ${badDeps.join(", ")}. Existing tasks: ${[...existingIds].join(", ")}` }], details: undefined };
				}
				const targetCwd = store.loadSquad(squadId)!.cwd;
				if (!store.loadAgentDef(params.task.agent, targetCwd)) {
					const available = store.loadAllAgentDefs(targetCwd).filter((a) => !a.disabled).map((a) => a.name).join(", ");
					return { content: [{ type: "text" as const, text: `Unknown agent '${params.task.agent}'. Available: ${available}` }], details: undefined };
				}
				const forkFromTask = params.task.forkFromTask?.trim();
				if (forkFromTask) {
					if (params.task.inheritContext) {
						return { content: [{ type: "text" as const, text: "Choose either forkFromTask or inheritContext, not both." }], details: undefined };
					}
					if (!existingIds.has(forkFromTask)) {
						return { content: [{ type: "text" as const, text: `forkFromTask '${forkFromTask}' not found in squad '${squadId}'. Existing tasks: ${[...existingIds].join(", ")}` }], details: undefined };
					}
					if (!store.loadTaskSession(squadId, forkFromTask)) {
						return { content: [{ type: "text" as const, text: `forkFromTask '${forkFromTask}' has no durable session yet (it never spawned). Add the task without forkFromTask, or fork a task that has run.` }], details: undefined };
					}
				}
				const dependencies = params.task.depends || [];
				const task: Task = {
					id: params.task.id,
					title: params.task.title,
					description: params.task.description || "",
					agent: params.task.agent,
					status: dependencies.every((dependency) => existing.find((candidate) => candidate.id === dependency)?.status === "done") ? "pending" : "blocked",
					depends: dependencies,
					...(params.task.inheritContext ? { inheritContext: true } : {}),
					...(forkFromTask ? { forkFromTaskId: forkFromTask } : {}),
					...(targetSquad.spec ? { fileSpecDelta: true } : {}),
					created: store.now(),
					started: null,
					completed: null,
					output: null,
					error: null,
					usage: { inputTokens: 0, outputTokens: 0, cost: 0, turns: 0 },
				};
				try {
					await activeScheduler.addTask(task);
				} catch (err) {
					return { content: [{ type: "text" as const, text: `add_task failed: ${(err as Error).message}` }], details: undefined };
				}
				return { content: [{ type: "text" as const, text: `Task '${task.id}' added to squad '${squadId}'.` }], details: undefined };
			}

			case "set_dependencies": {
				if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }], details: undefined };
				if (!params.depends) return { content: [{ type: "text" as const, text: "Provide top-level depends for set_dependencies (use [] to remove all dependencies)." }], details: undefined };
				try {
					await activeScheduler.setDependencies(params.taskId, params.depends);
				} catch (err) {
					return { content: [{ type: "text" as const, text: `set_dependencies failed: ${(err as Error).message}` }], details: undefined };
				}
				return { content: [{ type: "text" as const, text: `Task '${params.taskId}' dependencies updated in squad '${squadId}'.` }], details: undefined };
			}

			case "cancel_task": {
				if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }], details: undefined };
				try {
					await activeScheduler.cancelTask(params.taskId);
				} catch (err) {
					return { content: [{ type: "text" as const, text: `cancel_task failed: ${(err as Error).message}` }], details: undefined };
				}
				return { content: [{ type: "text" as const, text: `Task '${params.taskId}' cancelled.` }], details: undefined };
			}

			case "pause_task": {
				if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }], details: undefined };
				await activeScheduler.pauseTask(params.taskId);
				return { content: [{ type: "text" as const, text: `Task '${params.taskId}' paused.` }], details: undefined };
			}

			case "resume_task": {
				if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }], details: undefined };
				try {
					const result = await activeScheduler.resumeTask(params.taskId);
					if (result === "already_running") {
						return { content: [{ type: "text" as const, text: `Task '${params.taskId}' is already running in squad '${squadId}'; no duplicate resume was started.` }], details: undefined };
					}
				} catch (err) {
					return { content: [{ type: "text" as const, text: `resume_task failed for task '${params.taskId}' in squad '${squadId}': ${(err as Error).message}` }], details: undefined };
				}
				return { content: [{ type: "text" as const, text: `Task '${params.taskId}' resumed in squad '${squadId}'.` }], details: undefined };
			}

			case "complete_task": {
				if (!params.taskId) return { content: [{ type: "text" as const, text: "Provide taskId." }], details: undefined };
				try {
					await activeScheduler.completeTask(params.taskId, params.output);
				} catch (err) {
					return { content: [{ type: "text" as const, text: `complete_task failed: ${(err as Error).message}` }], details: undefined };
				}
				return { content: [{ type: "text" as const, text: `Task '${params.taskId}' marked done — dependents unblocked and scheduled.` }], details: undefined };
			}

			case "pause": {
				const squad = store.loadSquad(squadId);
				if (squad) {
					squad.status = "paused";
					store.saveSquad(squad);
				}
				await activeScheduler.stop();
				return { content: [{ type: "text" as const, text: "Squad paused. Use squad_modify with action 'resume' to continue." }], details: undefined };
			}

			// Note: "resume" and exact-ID "cancel" are handled above.

			default:
				return { content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }], details: undefined };
		}
	},
});

}
