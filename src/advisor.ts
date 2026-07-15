/**
 * advisor.ts — Squad advisor: consult a stronger model when an agent is stuck.
 *
 * Modeled on the advisor tool pattern (pi-advisor / Anthropic's advisor
 * strategy): the agent keeps doing the work; when the Monitor detects it is
 * stuck, looping, or timing out, the squad consults an advisor model with a
 * curated context digest and steers the agent with the returned verdict +
 * action items. Escalation to the human happens only when the advisor is
 * disabled, exhausted, or fails.
 *
 * This module is pure (no pi imports) so it stays unit-testable.
 */

import type { Task, TaskMessage } from "./types.js";

// ============================================================================
// Settings
// ============================================================================

export interface AdvisorSettings {
	/** Consult an advisor before escalating stuck agents to the human */
	enabled: boolean;
	/** "main" = main session's current model, or an explicit "provider/id" */
	model: string;
	/** Max advisor consultations per task before escalating for real */
	maxCallsPerTask: number;
	/** Max output tokens per advisor call (thinking tokens count on adaptive models) */
	maxTokens: number;
	/** Reasoning effort for the advisor call */
	reasoning: string;
}

export const DEFAULT_ADVISOR_SETTINGS: AdvisorSettings = {
	enabled: true,
	model: "main",
	maxCallsPerTask: 2,
	maxTokens: 8192,
	reasoning: "medium",
};

// ============================================================================
// Consult input/output
// ============================================================================

export interface AdvisorConsultInput {
	taskId: string;
	taskTitle: string;
	taskDescription: string;
	agentName: string;
	agentRole: string;
	/** Why the monitor flagged this agent (stuck, looping, timeout...) */
	reason: string;
	/** Recent task messages (already tailed by the caller) */
	recentMessages: Pick<TaskMessage, "from" | "type" | "text">[];
	/** Recent tool call summaries from agent activity */
	recentToolCalls: string[];
	turnCount: number;
	elapsedMinutes: number;
}

// ============================================================================
// Prompts
// ============================================================================

export const ADVISOR_SYSTEM_PROMPT = `You are a senior engineering advisor for an autonomous squad agent that has run into trouble. The agent works on one task inside a multi-agent squad; a monitor flagged it (stuck, looping, or idle) and you are consulted before the problem is escalated to a human.

Your role:
- You see a curated digest: the task, recent messages, and recent tool activity summaries — not the full transcript
- If the evidence is too thin to judge, say so — never fill gaps with guesses
- You cannot call tools. Your advice is injected directly into the agent's conversation as a steering message and it will act on it immediately

Output format:
- Lead with a one-sentence verdict: "Course-correct", "Push through", or "Needs human input"
- Follow with numbered action items (max 5) the agent should take next
- If the evidence doesn't settle a point, make your FIRST action item the exact command or file read that would settle it — instead of guessing
- Reference specific files, commands, or error signals from the digest
- If the blocker genuinely requires a human decision (product choice, missing credentials, destructive action), say "Needs human input" and state the exact question to ask

Keep it short. The agent reads your advice and immediately acts on it.`;

/**
 * Build the user-message digest sent to the advisor model.
 * Preserve complete descriptions, messages, and tool history: advisor handoffs
 * follow the same no-truncation contract as task and completion reports.
 */
export function buildAdvisorConsultText(input: AdvisorConsultInput): string {
	const lines: string[] = [];

	lines.push(`# Stuck Agent Consultation`);
	lines.push("");
	lines.push(`Agent: ${input.agentName} (${input.agentRole})`);
	lines.push(`Task: ${input.taskId} — ${input.taskTitle}`);
	lines.push(`Monitor flag: ${input.reason}`);
	lines.push(`Progress: ${input.turnCount} turns, ~${Math.round(input.elapsedMinutes)} min elapsed`);
	lines.push("");
	lines.push(`## Task Description`);
	lines.push((input.taskDescription || "(no description)").trim());

	if (input.recentToolCalls.length > 0) {
		lines.push("");
		lines.push(`## Recent Tool Activity (newest last)`);
		for (const call of input.recentToolCalls) {
			lines.push(`- ${call.trim()}`);
		}
	}

	if (input.recentMessages.length > 0) {
		lines.push("");
		lines.push(`## Recent Messages (newest last)`);
		for (const msg of input.recentMessages) {
			lines.push(`[${msg.from}/${msg.type}] ${msg.text.trim()}`);
		}
	}

	lines.push("");
	lines.push(`Provide your verdict and action items now.`);
	return lines.join("\n");
}

/**
 * Format advisor advice as a steering message for the agent.
 */
export function formatAdvisorSteerMessage(advice: string, reason: string): string {
	return [
		`[squad advisor] A monitor flagged your task (${reason}) and a senior advisor reviewed your situation. Guidance:`,
		"",
		advice.trim(),
		"",
		`Execute these action items unless your evidence contradicts them — in that case state the conflict explicitly instead of silently ignoring the advice.`,
	].join("\n");
}

/** True when the advisor's verdict says a human decision is required. */
export function adviceNeedsHuman(advice: string): boolean {
	return /needs human input/i.test(advice);
}
