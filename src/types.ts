// ============================================================================
// Agent Definitions
// ============================================================================

export interface AgentDef {
	/** Agent identifier, matches filename */
	name: string;
	/** One-line role title */
	role: string;
	/** What this agent does (used by planner to pick agents) */
	description: string;
	/** Override model (null = squad default or pi default) */
	model: string | null;
	/** Thinking level: off, minimal, low, medium, high, xhigh, max (null = pi default) */
	thinking?: string | null;
	/** Override tool list (null = all standard tools) */
	tools: string[] | null;
	/** Tags for planner's automatic agent matching */
	tags: string[];
	/** System prompt injected via --append-system-prompt */
	prompt: string;
	/** When true, agent is hidden from the planner and cannot be assigned tasks */
	disabled?: boolean;
}

/** Agent entry in squad.json — just overrides, references an AgentDef by key */
export interface SquadAgentEntry {
	model?: string | null;
	thinking?: string | null;
}

/** Valid thinking levels accepted by pi's --thinking flag */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// ============================================================================
// Squad Settings (global, ~/.pi/squad/settings.json)
// ============================================================================

/**
 * Default model/thinking policy for agents whose def doesn't set one.
 * - "main": follow the main pi session's current model / thinking level (default)
 * - "pi-default": let the child pi process resolve its own configured default
 * - any other string: an explicit model id (defaultModel) or thinking level (defaultThinking)
 */
export interface SquadSettings {
	defaultModel: string;
	defaultThinking: string;
	advisor: {
		enabled: boolean;
		model: string;
		maxCallsPerTask: number;
		maxTokens: number;
		reasoning: string;
	};
}

export const DEFAULT_SQUAD_SETTINGS: SquadSettings = {
	defaultModel: "main",
	defaultThinking: "main",
	advisor: {
		enabled: true,
		model: "main",
		maxCallsPerTask: 2,
		maxTokens: 8192,
		reasoning: "medium",
	},
};

// ============================================================================
// Squad
// ============================================================================

export type SquadStatus = "planning" | "running" | "paused" | "review" | "done" | "failed";

export interface SquadReview {
	status: "pending" | "passed" | "failed";
	requestedAt: string;
	completedAt: string | null;
	verdict: "pass" | "pass_with_issues" | "fail" | null;
	contractChecks: string[];
	diffReview: string;
	verificationEvidence: string[];
	integrationEvidence: string;
	issues: string[];
}

export interface SuspendedStallAttention {
	kind: "suspended_stall";
	/** Canonical identity of the exact suspended/blocked task sets. */
	fingerprint: string;
	suspendedTaskIds: string[];
	blockedTaskIds: string[];
	detectedAt: string;
	delivery: "pending" | "delivered";
	deliveredAt: string | null;
}

export interface SquadConfig {
	maxConcurrency: number;
	autoUnblock: boolean;
	/** @deprecated Independent main-orchestrator review is always required. */
	reviewOnComplete: boolean;
	/** Max rework attempts when QA fails a task (0 = no rework, just fail) */
	maxRetries: number;
}

export const DEFAULT_SQUAD_CONFIG: SquadConfig = {
	maxConcurrency: 2,
	autoUnblock: true,
	reviewOnComplete: true,
	maxRetries: 2,
};

export interface Squad {
	id: string;
	goal: string;
	status: SquadStatus;
	created: string;
	cwd: string;
	/** Session file of the pi session that created this squad (for inheritContext forks) */
	sessionFile?: string | null;
	/** Agent name → overrides. Keys must exist in .pi/squad/agents/ */
	agents: Record<string, SquadAgentEntry>;
	config: SquadConfig;
	/** Immutable canonical contract for file-based squads; absent for legacy inline squads. */
	spec?: { schemaVersion: 1; sha256: string; bytes: number; path: string; chunkBytes: 32768; chunkCount: number };
	/** Mandatory independent main-session review; absent while rework is running. */
	review?: SquadReview;
	/** Completed prior review attempts retained as same-squad audit evidence. */
	reviewHistory?: SquadReview[];
	/** Durable, level-triggered attention for an explicit-suspension stall. */
	suspendedStallAttention?: SuspendedStallAttention;
}

// ============================================================================
// Tasks
// ============================================================================

export type TaskStatus = "pending" | "blocked" | "in_progress" | "done" | "failed" | "suspended" | "cancelled";

export interface TaskUsage {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	turns: number;
}

/** Durable Pi session owned by one task. Once bound, the file identity is immutable. */
export interface TaskSession {
	/** Absolute Pi session JSONL path, suitable for `pi --session`. */
	file: string;
	/** Pi's session UUID from RPC get_state, when available. */
	sessionId?: string;
}

export interface Task {
	id: string;
	title: string;
	description: string;
	agent: string;
	status: TaskStatus;
	depends: string[];
	/** Fork the main pi session so this agent inherits the full conversation context.
	 * Skipped automatically if the estimated context exceeds 50% of the agent model's window. */
	inheritContext?: boolean;
	created: string;
	started: string | null;
	completed: string | null;
	output: string | null;
	error: string | null;
	usage: TaskUsage;
	/** Durable Pi context for this task. Absent until its first process creates a session. */
	session?: TaskSession;
	/** Dynamic task delta created after immutable file-spec publication. */
	fileSpecDelta?: boolean;
	/** If this is a rework task, the original task ID it's fixing */
	retryOf?: string;
	/** How many times this task chain has been retried */
	retryCount?: number;
	/** QA feedback that triggered this rework */
	qaFeedback?: string;
}

// ============================================================================
// Messages (JSONL entries)
// ============================================================================

export type MessageType = "status" | "text" | "tool" | "mention" | "reply" | "message" | "done" | "error";

export interface TaskMessage {
	/** Stable ID when the message participates in the durable task mailbox. */
	id?: string;
	ts: string;
	from: string;
	type: MessageType;
	text: string;
	to?: string;
	/** Main-orchestrator message expects the next substantive agent response. */
	expectsReply?: boolean;
	name?: string;
	args?: Record<string, unknown>;
}

/**
 * Durable inbound delivery record owned by a task ID. Entries are retained
 * after acknowledgement so task history remains available across restarts.
 */
export interface TaskMailboxEntry {
	id: string;
	taskId: string;
	enqueuedAt: string;
	deliveredAt: string | null;
	message: TaskMessage;
}

// ============================================================================
// Context (extension-maintained live state)
// ============================================================================

export interface ContextAgentState {
	role: string;
	status: "working" | "idle";
	task: string | null;
}

export interface ContextTaskState {
	status: TaskStatus;
	agent: string;
	title: string;
	output?: string;
	blockedBy?: string[];
	subtasks?: Record<string, ContextTaskState>;
}

export interface ContextActivity {
	ts: string;
	agent: string;
	action: string;
}

export interface SquadContext {
	goal: string;
	status: SquadStatus;
	elapsed: string;
	costs: {
		total: number;
		byAgent: Record<string, number>;
	};
	agents: Record<string, ContextAgentState>;
	tasks: Record<string, ContextTaskState>;
	recentActivity: ContextActivity[];
	modifiedFiles: Record<string, string[]>;
}

// ============================================================================
// Knowledge (JSONL entries)
// ============================================================================

export type KnowledgeType = "decision" | "convention" | "finding";

export interface KnowledgeEntry {
	ts: string;
	from: string;
	squad?: string;
	type: KnowledgeType;
	text: string;
}

// ============================================================================
// Scheduler
// ============================================================================

export interface AgentActivity {
	taskId: string;
	agentName: string;
	lastOutputTs: number;
	startedAt: number;
	turnCount: number;
	/** Ring buffer of recent tool call signatures for loop detection */
	recentToolCalls: string[];
	/** Set of file paths this agent has modified */
	modifiedFiles: Set<string>;
}

export type HealthStatus = "healthy" | "idle_warning" | "stuck" | "looping" | "long_running";

// ============================================================================
// Supervisor
// ============================================================================

export type SupervisorVerdict = "approve" | "revise" | "escalate";

export interface SupervisorResult {
	verdict: SupervisorVerdict;
	reason: string;
	feedback?: string;
}

// ============================================================================
// Planner
// ============================================================================

export interface PlannerOutput {
	agents: Record<string, SquadAgentEntry>;
	tasks: Array<{
		id: string;
		title: string;
		description: string;
		agent: string;
		depends: string[];
		inheritContext?: boolean;
	}>;
}

// ============================================================================
// Panel
// ============================================================================

export type PanelView = "tasks" | "messages" | "agents";

export interface PanelState {
	view: PanelView;
	selectedTaskIndex: number;
	selectedTaskId: string | null;
	scrollOffset: number;
	agentSelectedIndex: number;
}
