/**
 * supervisor.ts — On-demand planner agent calls for quality review,
 * plan revision, and conflict resolution.
 *
 * Spawns a short-lived planner agent (one-shot, --mode json) for
 * decisions that need LLM judgment rather than mechanical rules.
 */

import type { Squad, SupervisorResult, Task } from "./types.js";
import * as store from "./store.js";

// ============================================================================
// Supervisor Calls
// ============================================================================

/**
 * Review a completed task's output.
 * Returns approve/revise/escalate verdict.
 */
export async function reviewTaskCompletion(
	squadId: string,
	task: Task,
): Promise<SupervisorResult> {
	const squad = store.loadSquad(squadId);
	if (!squad) {
		return { verdict: "approve", reason: "Squad not found, auto-approving" };
	}

	const dependents = store
		.loadAllTasks(squadId)
		.filter((t) => t.depends.includes(task.id));

	const prompt = `Review this completed task for the squad "${squad.goal}":

Task: ${task.title}
Description: ${task.description}
Agent: ${task.agent}
Output: ${task.output || "(no output)"}

Dependent tasks waiting on this:
${dependents.map((t) => `- ${t.title} (${t.agent})`).join("\n") || "(none)"}

Questions:
1. Does the output satisfy the task description?
2. Will dependent tasks have enough context from this output?
3. Any concerns before proceeding?

Respond with JSON only:
{"verdict":"approve"|"revise"|"escalate","reason":"...","feedback":"..."}`;

	try {
		// For now, auto-approve. Full implementation would spawn planner in json mode.
		// This avoids blocking the scheduler on a review for MVP.
		return { verdict: "approve", reason: "Auto-approved (supervisor review not yet enabled)" };
	} catch (error) {
		return {
			verdict: "approve",
			reason: `Supervisor error: ${(error as Error).message}. Auto-approving.`,
		};
	}
}

/**
 * Analyze a stuck agent and suggest next steps.
 */
export async function analyzeStuckAgent(
	squadId: string,
	taskId: string,
	agentName: string,
): Promise<{ action: "retry" | "reassign" | "escalate"; reason: string; suggestion?: string }> {
	const task = store.loadTask(squadId, taskId);
	const messages = store.loadMessages(squadId, taskId);
	const recentMessages = messages.slice(-10);

	// Simple heuristic for now
	const errorMessages = recentMessages.filter((m) => m.type === "error");
	if (errorMessages.length >= 3) {
		return {
			action: "escalate",
			reason: `Agent ${agentName} has ${errorMessages.length} errors on task ${taskId}`,
			suggestion: "Check the error messages and consider a different approach",
		};
	}

	return {
		action: "retry",
		reason: `Agent ${agentName} appears stuck on ${taskId}, attempting retry`,
	};
}

/**
 * Determine if a blocked agent's request warrants a new subtask.
 */
export async function analyzeBlockRequest(
	squadId: string,
	taskId: string,
	agentName: string,
	blockReason: string,
): Promise<{
	action: "create_subtask" | "route_message" | "escalate";
	subtask?: { title: string; agent: string; description: string };
	targetAgent?: string;
	message?: string;
}> {
	// Simple pattern matching for common block reasons
	const lower = blockReason.toLowerCase();

	// If they mention a specific agent, route to them
	const mentionMatch = lower.match(/@(\w+)/);
	if (mentionMatch) {
		const target = mentionMatch[1];
		const projectCwd = store.loadSquad(squadId)?.cwd;
		const agentDef = store.loadAgentDef(target, projectCwd);
		if (agentDef) {
			return {
				action: "route_message",
				targetAgent: target,
				message: blockReason,
			};
		}
	}

	// If they mention needing something built/created, suggest a subtask
	if (
		lower.includes("need") &&
		(lower.includes("create") || lower.includes("build") || lower.includes("implement"))
	) {
		return {
			action: "create_subtask",
			subtask: {
				title: `Support: ${blockReason.slice(0, 60)}`,
				agent: "fullstack",
				description: `Created from block request by ${agentName} on task ${taskId}: ${blockReason}`,
			},
		};
	}

	// Default: escalate to human
	return {
		action: "escalate",
		message: `Agent ${agentName} blocked on ${taskId}: ${blockReason}`,
	};
}
