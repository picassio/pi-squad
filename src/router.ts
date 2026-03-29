/**
 * router.ts — @mention parsing and cross-agent message delivery.
 *
 * Parses assistant text for @agentname patterns.
 * Routes messages to target agents via steer() if running,
 * or queues them for delivery on next spawn.
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
		for (const mention of mentions) {
			this.routeMention(taskId, fromAgent, mention.target, mention.message);
		}

		// Detect block signals
		if (this.isBlockSignal(text)) {
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
	): void {
		// Log the mention in the source task
		store.appendMessage(this.squadId, sourceTaskId, {
			ts: store.now(),
			from: fromAgent,
			type: "mention",
			to: targetAgent,
			text: message,
		});

		// Find if target agent is running
		const targetTaskId = this.pool.getTaskIdForAgent(targetAgent);

		if (targetTaskId && this.pool.isRunning(targetTaskId)) {
			// Target is running — steer them
			const steerMessage = `[squad] Message from @${fromAgent} (working on ${sourceTaskId}):\n${message}`;
			this.pool.steer(targetTaskId, steerMessage);

			// Log in target task too
			store.appendMessage(this.squadId, targetTaskId, {
				ts: store.now(),
				from: fromAgent,
				type: "mention",
				to: targetAgent,
				text: message,
			});
		} else {
			// Target not running — queue for later
			this.pool.queueMessage(targetAgent, {
				ts: store.now(),
				from: fromAgent,
				type: "mention",
				to: targetAgent,
				text: message,
			});
		}
	}

	/**
	 * Route a human message to an agent.
	 */
	routeHumanMessage(taskId: string, message: string): void {
		store.appendMessage(this.squadId, taskId, {
			ts: store.now(),
			from: "human",
			type: "message",
			text: message,
		});

		if (this.pool.isRunning(taskId)) {
			this.pool.steer(taskId, `[squad] Human: ${message}`);
		} else {
			const task = store.loadTask(this.squadId, taskId);
			if (task) {
				this.pool.queueMessage(task.agent, {
					ts: store.now(),
					from: "human",
					type: "message",
					text: message,
				});
			}
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
		return text.slice(0, 200);
	}
}
