/**
 * router.ts — @mention parsing and cross-agent message delivery.
 *
 * Parses assistant text for @agentname patterns.
 * Routes messages to exact target tasks via steer() if running,
 * or a durable task-owned mailbox for delivery on next spawn.
 */

import type { AgentPool } from "./agent-pool.js";
import type { TaskMessage } from "./types.js";
import * as store from "./store.js";

// ============================================================================
// Types
// ============================================================================

export type EscalationListener = (taskId: string, agentName: string, message: string) => void;

// ============================================================================
// Router
// ============================================================================

export class Router {
	private pool: AgentPool;
	private squadId: string;
	private escalationListeners: EscalationListener[] = [];

	constructor(pool: AgentPool, squadId: string) {
		this.pool = pool;
		this.squadId = squadId;
	}

	/** Subscribe to escalation events (agent blocked, needs human) */
	onEscalation(listener: EscalationListener): () => void {
		this.escalationListeners.push(listener);
		return () => {
			const idx = this.escalationListeners.indexOf(listener);
			if (idx !== -1) this.escalationListeners.splice(idx, 1);
		};
	}

	/**
	 * Process an assistant message for signals:
	 * - @mentions → route to target agent
	 * - Block signals → detect and escalate
	 */
	processMessage(taskId: string, fromAgent: string, text: string): void {
		// Parse @mentions
		const mentions = this.parseMentions(text, fromAgent);
		let resolvedFromDurableOutput = false;
		for (const mention of mentions) {
			const resolved = this.routeMention(taskId, fromAgent, mention.target, mention.message);
			// Only suppress escalation when the resolved mention itself expressed
			// the blocker; an unrelated completed-agent FYI must not hide another block.
			resolvedFromDurableOutput =
				(resolved && this.isBlockSignal(mention.message)) || resolvedFromDurableOutput;
		}

		// Do not wake the human for a blocker we immediately resolved from a
		// completed agent's durable task output.
		if (this.isBlockSignal(text) && !resolvedFromDurableOutput) {
			for (const listener of this.escalationListeners) {
				listener(taskId, fromAgent, this.extractBlockReason(text));
			}
		}
	}

	/**
	 * Route a message from one agent to another.
	 */
	routeMention(
		sourceTaskId: string,
		fromAgent: string,
		targetAgent: string,
		message: string,
	): boolean {
		// Log the mention in the source task
		store.appendMessage(this.squadId, sourceTaskId, {
			ts: store.now(),
			from: fromAgent,
			type: "mention",
			to: targetAgent,
			text: message,
		});

		// Agent-name mentions are safe only when exactly one live task owns that
		// role. Multiple concurrent same-role tasks must never receive guessed mail.
		const liveTargets = store.loadAllTasks(this.squadId).filter(
			(task) => task.agent === targetAgent && this.pool.isRunning(task.id),
		);
		const targetTaskId = liveTargets.length === 1 ? liveTargets[0].id : undefined;

		if (targetTaskId) {
			const queued = store.queueTaskMessage(this.squadId, targetTaskId, {
				ts: store.now(),
				from: fromAgent,
				type: "mention",
				to: targetAgent,
				text: message,
			});
			const steerMessage = `[squad] Message from @${fromAgent} (working on ${sourceTaskId}):\n${message}`;
			void this.pool.steer(targetTaskId, steerMessage).then((delivered) => {
				if (delivered) store.acknowledgeTaskMessages(this.squadId, targetTaskId, [queued.id]);
			});
			return false;
		}

		const targetTasks = store.loadAllTasks(this.squadId).filter((task) => task.agent === targetAgent);
		const futureTasks = targetTasks.filter((task) =>
			task.status === "in_progress" || task.status === "pending" || task.status === "suspended" || task.status === "blocked",
		);
		const interrupted = futureTasks.filter((task) => task.status === "in_progress");
		// Never guess between two tasks assigned to the same role. A uniquely
		// interrupted task is authoritative; otherwise only one future task is safe.
		const futureTask = interrupted.length === 1
			? interrupted[0]
			: futureTasks.length === 1
				? futureTasks[0]
				: undefined;
		if (futureTasks.length === 0) {
			const completed = targetTasks.filter((task) => task.status === "done" && task.output);
			if (completed.length > 0) {
				const durableReply = [
					`[squad] @${targetAgent} has completed and is no longer running. Durable completed output:`,
					...completed.map((task) => `\n## ${task.id}: ${task.title}\n${task.output}`),
				].join("\n");
				const reply = {
					ts: store.now(),
					from: targetAgent,
					type: "reply" as const,
					to: fromAgent,
					text: durableReply,
				};
				const queued = store.queueTaskMessage(this.squadId, sourceTaskId, reply);
				if (this.pool.isRunning(sourceTaskId)) {
					void this.pool.steer(sourceTaskId, durableReply).then((delivered) => {
						if (delivered) store.acknowledgeTaskMessages(this.squadId, sourceTaskId, [queued.id]);
					});
				}
				return true;
			}
		}

		// Target has future work and may spawn again. Bind the message to exactly
		// one durable task, never to the shared role name.
		if (futureTask) {
			store.queueTaskMessage(this.squadId, futureTask.id, {
				ts: store.now(),
				from: fromAgent,
				type: "mention",
				to: targetAgent,
				text: message,
			});
		}
		return false;
	}

	/**
	 * Route a human message to an agent.
	 */
	routeHumanMessage(taskId: string, message: string): void {
		const queued = store.queueTaskMessage(this.squadId, taskId, {
			ts: store.now(),
			from: "human",
			type: "message",
			text: message,
		});

		if (this.pool.isRunning(taskId)) {
			void this.pool.steer(taskId, `[squad] Human: ${message}`).then((delivered) => {
				if (delivered) store.acknowledgeTaskMessages(this.squadId, taskId, [queued.id]);
			});
		}
	}

	// =========================================================================
	// Parsing
	// =========================================================================

	/**
	 * Parse @mentions from text.
	 * Matches @agentname followed by text until the next @mention or end of line.
	 */
	private parseMentions(
		text: string,
		fromAgent: string,
	): Array<{ target: string; message: string }> {
		const mentions: Array<{ target: string; message: string }> = [];
		// Match @word at start of line or after whitespace, capture until next @mention or newline
		const regex = /(?:^|\s)@(\w+)\s+([^\n@]*(?:\n(?!.*@\w).*)*)/gm;

		for (const match of text.matchAll(regex)) {
			const target = match[1];
			const message = match[2].trim();

			// Don't route self-mentions
			if (target === fromAgent) continue;

			// Don't route empty messages
			if (!message) continue;

			// Check if target is a known agent
			const projectCwd = store.loadSquad(this.squadId)?.cwd;
			const agentDef = store.loadAgentDef(target, projectCwd);
			if (agentDef) {
				mentions.push({ target, message });
			}
		}

		return mentions;
	}

	/**
	 * Detect if text indicates the agent is blocked.
	 */
	private isBlockSignal(text: string): boolean {
		const lower = text.toLowerCase();
		const blockPatterns = [
			/\bi(?:'m| am) blocked\b/,
			/\bcannot proceed\b/,
			/\bcan't proceed\b/,
			/\bneed .+ (?:before|to proceed|to continue)/,
			/\bwaiting (?:for|on) .+ (?:input|decision|response)/,
			/\bblocked(?:\s+because|\s+by|\s*:)/,
		];
		return blockPatterns.some((p) => p.test(lower));
	}

	/**
	 * Extract the block reason from text.
	 */
	private extractBlockReason(text: string): string {
		// Try to find the line with the block signal
		const lines = text.split("\n");
		for (const line of lines) {
			const lower = line.toLowerCase();
			if (
				lower.includes("blocked") ||
				lower.includes("cannot proceed") ||
				lower.includes("can't proceed") ||
				lower.includes("waiting for") ||
				lower.includes("waiting on")
			) {
				return line.trim();
			}
		}
		return text;
	}
}
