/**
 * protocol.ts — System prompt builder for squad agents.
 *
 * Assembles the full context that gets injected into each agent via --append-system-prompt:
 * 1. Squad protocol (communication rules)
 * 2. Agent identity (role, custom prompt)
 * 3. Chain context (completed dependency outputs)
 * 4. Sibling awareness (parallel tasks, file map)
 * 5. Knowledge entries (decisions, conventions, findings)
 * 6. Queued messages (received while agent wasn't running)
 */

import type { AgentDef, KnowledgeEntry, Squad, Task, TaskMessage } from "./types.js";
import { loadAllKnowledge, loadAllTasks, loadMessages, loadOverview } from "./store.js";

// ============================================================================
// Squad Protocol (injected into every agent)
// ============================================================================

function buildSquadProtocol(agentName: string, agentDef: AgentDef, squad: Squad): string {
	const agentList = Object.entries(squad.agents)
		.map(([name]) => `- ${name}`)
		.join("\n");

	return `# Squad Protocol

You are agent "${agentName}" (${agentDef.role}) in a multi-agent squad.

**Goal:** ${squad.goal}

## Team
${agentList}

## Communication

### Talking to other agents
Write @agentname followed by your message in your regular output.
The squad system parses @mentions and routes them to the target agent.
- "@frontend what token format do you need?"
- "@backend the schema needs a role column"

### Receiving messages
Messages from other agents and the human will arrive as interruptions
injected into your conversation. Read them, incorporate the info, and continue.

### Completion
When you finish your task, clearly state your final output in your last message.
This output gets passed to dependent tasks as context.

### Blocking
If you cannot proceed, clearly explain what you need and from whom.
The squad system will detect this and route help.

## Rules
- Stay focused on YOUR task — don't do work assigned to other agents
- Read the dependency outputs below — don't redo completed work
- **Follow the Design Contract in the Squad Progress Document** — use the exact API paths, ports, schemas, and file names specified. Do NOT invent alternatives
- Check the modified files list — coordinate before editing shared files
- When creating APIs, clearly document all endpoints, request/response shapes, and status codes in your completion output
- Ask for help if stuck — don't spin for more than a few minutes
- Verify your work before claiming done
`;
}

// ============================================================================
// Agent Identity
// ============================================================================

function buildAgentIdentity(agentDef: AgentDef): string {
	if (!agentDef.prompt) return "";
	return `# Agent Identity: ${agentDef.name}

Role: ${agentDef.role}
${agentDef.description}

${agentDef.prompt}
`;
}

// ============================================================================
// Chain Context (completed dependency outputs)
// ============================================================================

function buildChainContext(task: Task, allTasks: Task[], squadId: string): string {
	if (task.depends.length === 0) return "";

	const sections: string[] = [];

	for (const depId of task.depends) {
		const dep = allTasks.find((t) => t.id === depId);
		if (!dep || dep.status !== "done") continue;

		let section = `## ${dep.id} (done by ${dep.agent})\n**${dep.title}**\n`;
		if (dep.output) {
			section += `\nOutput:\n${dep.output}\n`;
		} else {
			// Fall back to last messages if no explicit output
			const messages = loadMessages(squadId, dep.id);
			const lastText = messages
				.filter((m) => m.from === dep.agent && (m.type === "text" || m.type === "done"))
				.slice(-3)
				.map((m) => m.text)
				.join("\n");
			if (lastText) {
				section += `\nLast messages:\n${lastText}\n`;
			}
		}
		sections.push(section);
	}

	if (sections.length === 0) return "";

	return `# Completed Dependencies

${sections.join("\n---\n\n")}
`;
}

// ============================================================================
// Squad Progress Overview
// ============================================================================

/**
 * Only inject the Design Contract from OVERVIEW.md into agent prompts.
 * Task summaries are NOT injected — chain context already provides
 * dependency outputs, and the full overview just adds noise that
 * confuses agents (especially later ones with long dependency chains).
 */
export function buildOverviewSection(squadId: string): string {
	const content = loadOverview(squadId);
	if (!content.trim()) return "";

	// Extract only the Design Contract section
	const contractMatch = content.match(/## Design Contract[\s\S]*?(?=\n---\n|\n## (?!Design)|$)/);
	if (!contractMatch) return "";

	return `# Shared Design Contract

${contractMatch[0].trim()}
`;
}

// ============================================================================
// Sibling Awareness
// ============================================================================

function buildSiblingAwareness(
	task: Task,
	allTasks: Task[],
	modifiedFiles: Record<string, string[]>,
): string {
	const siblings = allTasks.filter(
		(t) => t.id !== task.id && (t.status === "in_progress" || t.status === "blocked" || t.status === "pending"),
	);

	if (siblings.length === 0 && Object.keys(modifiedFiles).length === 0) return "";

	const lines: string[] = ["# Sibling Tasks\n"];

	if (siblings.length > 0) {
		lines.push("Other tasks in this squad:\n");
		for (const sib of siblings) {
			let line = `- **${sib.id}** [${sib.status}] — ${sib.agent} — ${sib.title}`;
			if (sib.status === "blocked" && sib.depends.some((d) => d === task.id)) {
				line += " ⚠️ WAITING ON YOUR TASK";
			}
			lines.push(line);
		}
	}

	// File ownership map
	const fileEntries = Object.entries(modifiedFiles).filter(([agent]) => agent !== task.agent);
	if (fileEntries.length > 0) {
		lines.push("\n## Files Modified by Other Agents\n");
		for (const [agent, files] of fileEntries) {
			if (files.length > 0) {
				lines.push(`**${agent}:**`);
				for (const f of files.slice(0, 10)) {
					lines.push(`  - ${f}`);
				}
				if (files.length > 10) {
					lines.push(`  - ...and ${files.length - 10} more`);
				}
			}
		}
		lines.push(
			"\n⚠️ Coordinate with the owning agent before editing files listed above.",
		);
	}

	return lines.join("\n") + "\n";
}

// ============================================================================
// Knowledge
// ============================================================================

function buildKnowledgeSection(squadId: string): string {
	const entries = loadAllKnowledge(squadId);
	if (entries.length === 0) return "";

	const decisions = entries.filter((e) => e.type === "decision");
	const conventions = entries.filter((e) => e.type === "convention");
	const findings = entries.filter((e) => e.type === "finding");

	const lines: string[] = ["# Squad Knowledge\n"];

	if (decisions.length > 0) {
		lines.push("## Decisions");
		for (const d of decisions.slice(-10)) {
			lines.push(`- ${d.text} (${d.from})`);
		}
		lines.push("");
	}

	if (conventions.length > 0) {
		lines.push("## Project Conventions");
		for (const c of conventions.slice(-10)) {
			lines.push(`- ${c.text} (${c.from})`);
		}
		lines.push("");
	}

	if (findings.length > 0) {
		lines.push("## Findings");
		for (const f of findings.slice(-10)) {
			lines.push(`- ${f.text} (${f.from})`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ============================================================================
// Queued Messages
// ============================================================================

function buildQueuedMessages(messages: TaskMessage[]): string {
	if (messages.length === 0) return "";

	const lines = ["# Messages Received While You Were Offline\n"];
	for (const msg of messages) {
		lines.push(`[${msg.ts}] ${msg.from}: ${msg.text}`);
	}
	lines.push("\nPlease read and incorporate these before starting your work.\n");
	return lines.join("\n");
}

// ============================================================================
// Task Description
// ============================================================================

function buildTaskSection(task: Task): string {
	return `# Your Task

**${task.title}**

${task.description || "(no additional description)"}
`;
}

// ============================================================================
// Rework Context
// ============================================================================

function buildReworkContext(task: Task, squadId: string): string {
	if (!task.retryOf) return "";

	const originalTask = loadAllTasks(squadId).find((t) => t.id === task.retryOf);

	const lines: string[] = [
		"# ⚠️ REWORK — Fix Issues From Previous Attempt\n",
		`This is attempt #${task.retryCount || 1} to fix issues in **${task.retryOf}**.\n`,
	];

	if (originalTask?.output) {
		lines.push("## What Was Built (Previous Attempt)");
		lines.push(originalTask.output.slice(0, 2000));
		lines.push("");
	}

	if (task.qaFeedback) {
		lines.push("## QA Feedback — What Needs Fixing");
		lines.push(task.qaFeedback);
		lines.push("");
	}

	lines.push("## Instructions");
	lines.push("- Read the QA feedback carefully — fix ONLY the reported issues");
	lines.push("- Do NOT rewrite everything from scratch");
	lines.push("- Make targeted, minimal fixes");
	lines.push("- Re-run the failing tests to verify your fixes");
	lines.push("- Include test output as evidence in your completion message\n");

	return lines.join("\n");
}

// ============================================================================
// Full Prompt Assembly
// ============================================================================

export interface ProtocolBuildOptions {
	squadId: string;
	squad: Squad;
	task: Task;
	agentDef: AgentDef;
	modifiedFiles: Record<string, string[]>;
	queuedMessages: TaskMessage[];
}

export function buildAgentSystemPrompt(options: ProtocolBuildOptions): string {
	const { squadId, squad, task, agentDef, modifiedFiles, queuedMessages } = options;
	const allTasks = loadAllTasks(squadId);

	const sections = [
		buildSquadProtocol(task.agent, agentDef, squad),
		buildAgentIdentity(agentDef),
		buildTaskSection(task),
		buildReworkContext(task, squadId),
		buildChainContext(task, allTasks, squadId),
		buildOverviewSection(squadId),
		buildSiblingAwareness(task, allTasks, modifiedFiles),
		buildKnowledgeSection(squadId),
		buildQueuedMessages(queuedMessages),
	].filter((s) => s.length > 0);

	return sections.join("\n---\n\n");
}
