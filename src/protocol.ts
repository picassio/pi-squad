/**
 * protocol.ts — System prompt builder for squad agents.
 *
 * Assembles the full context that gets injected into each agent via --append-system-prompt:
 * 1. Squad protocol (communication rules)
 * 2. Agent identity (role, custom prompt)
 * 3. Chain context (completed dependency outputs)
 * 4. Sibling awareness (parallel tasks, file map)
 * 5. Queued messages (received while agent wasn't running)
 */

import type { AgentDef, Squad, Task, TaskMessage } from "./types.js";
import { loadAllTasks, loadMessages } from "./store.js";

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
- Check the modified files list — coordinate before editing shared files
- Ask for help if stuck — don't spin for more than a few minutes
- Verify your work before claiming done — report the commands you ran and their results

## Boundaries
- If required information is missing or ambiguous, ask (@mention or escalate) — flag gaps instead of guessing or inventing
- Keep changes minimal and within your task's scope — don't refactor unrelated code or add unrequested polish
- Respect your task's stated boundaries: keep public APIs, schemas, and configs unchanged unless the task says otherwise
- Never take externally visible actions (git push, deploy, publish, send messages/emails) unless your task explicitly instructs it — prepare, don't ship
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

	// A downstream integration/QA task needs the contracts its direct inputs
	// were built from, not only the last edge in the DAG. Walk the complete
	// ancestor closure, ancestors first, and deduplicate diamond dependencies.
	for (const dep of completedDependencyClosure(task, allTasks)) {

		let section = `## ${dep.id} (done by ${dep.agent})\n**${dep.title}**\n`;
		if (dep.output) {
			section += `\nOutput:\n${dep.output}\n`;
		} else {
			// Fall back to last messages if no explicit output
			const messages = loadMessages(squadId, dep.id);
			const lastText = messages
				.filter((m) => m.from === dep.agent && (m.type === "text" || m.type === "done"))
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

function completedDependencyClosure(task: Task, allTasks: Task[]): Task[] {
	const byId = new Map(allTasks.map((candidate) => [candidate.id, candidate]));
	const seen = new Set<string>();
	const ordered: Task[] = [];

	const visit = (id: string): void => {
		if (seen.has(id)) return;
		seen.add(id);
		const dependency = byId.get(id);
		if (!dependency) return;
		for (const ancestorId of dependency.depends) visit(ancestorId);
		if (dependency.status === "done") ordered.push(dependency);
	};

	for (const dependencyId of task.depends) visit(dependencyId);
	return ordered;
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
				for (const f of files) {
					lines.push(`  - ${f}`);
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
		// Rework agents need the complete prior handoff, not an arbitrary prefix.
		lines.push(originalTask.output);
		lines.push("");
	}

	if (task.qaFeedback) {
		lines.push("## QA Feedback — What Needs Fixing");
		lines.push(task.qaFeedback);
		lines.push("");
	}

	lines.push("## Instructions");
	lines.push("- Read the QA feedback carefully — fix ONLY the reported issues");
	lines.push("- FIRST reproduce each reported issue (run the failing test or repro steps) — confirm you see the failure before changing code");
	lines.push("- Do NOT rewrite everything from scratch");
	lines.push("- Make targeted, minimal fixes");
	lines.push("- Re-run the failing tests to verify your fixes");
	lines.push("- Include test output as evidence in your completion message");
	lines.push("- Follow the squad-debugging skill for the full repro-first rework discipline\n");

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

	if (squad.spec) {
		const manifest = [
			"# File-spec squad bootstrap",
			`Squad ID: ${squad.id}`,
			`Task ID: ${task.id}`,
			`Spec SHA-256: ${squad.spec.sha256}`,
			`Spec bytes: ${squad.spec.bytes}`,
			`Chunk count: ${squad.spec.chunkCount}`,
			"Read every canonical chunk with squad_spec_read before using normal tools or completing the task.",
		].join("\n");
		const fileSections = [
			manifest,
			buildAgentIdentity(agentDef),
			...(task.fileSpecDelta ? [buildTaskSection(task), buildReworkContext(task, squadId)] : []),
			buildChainContext(task, allTasks, squadId),
			buildQueuedMessages(queuedMessages),
		].filter((section) => section.length > 0);
		return fileSections.join("\n---\n\n");
	}

	const sections = [
		buildSquadProtocol(task.agent, agentDef, squad),
		buildAgentIdentity(agentDef),
		buildTaskSection(task),
		buildReworkContext(task, squadId),
		buildChainContext(task, allTasks, squadId),
		buildSiblingAwareness(task, allTasks, modifiedFiles),
		buildQueuedMessages(queuedMessages),
	].filter((s) => s.length > 0);

	return sections.join("\n---\n\n");
}
