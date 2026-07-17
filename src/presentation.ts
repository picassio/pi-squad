import type { Squad, SuspendedStallAttention } from "./types.js";

export const REVIEW_PENDING_LABEL = "◆ REVIEW PENDING · independent review required";
export const REVIEW_FAILED_LABEL = "✗ REVIEW FAILED · awaiting same-squad rework";
export const SUSPENDED_ATTENTION_LABEL = "⚠ SUSPENDED — explicit resume required";

export interface ReviewPresentation {
	kind: "pending" | "failed";
	icon: "◆" | "✗";
	label: string;
	tone: "warning" | "error";
}

/** Keep execution progress separate from the independent acceptance gate. */
export function getReviewPresentation(squad: Squad): ReviewPresentation | null {
	if (squad.status !== "review") return null;
	if (squad.review?.status === "failed") {
		return { kind: "failed", icon: "✗", label: REVIEW_FAILED_LABEL, tone: "error" };
	}
	return { kind: "pending", icon: "◆", label: REVIEW_PENDING_LABEL, tone: "warning" };
}

export function getSuspendedAttention(squad: Squad): SuspendedStallAttention | null {
	return squad.suspendedStallAttention?.kind === "suspended_stall" ? squad.suspendedStallAttention : null;
}

/** Full-fidelity operator output. Terminal components may clip only while rendering. */
export function formatSuspendedAttention(squad: Squad): string[] {
	const attention = getSuspendedAttention(squad);
	if (!attention) return [];
	return [
		`Attention: ${SUSPENDED_ATTENTION_LABEL}`,
		`Suspended task IDs: ${attention.suspendedTaskIds.join(", ")}`,
		`Blocked by suspended work: ${attention.blockedTaskIds.length > 0 ? attention.blockedTaskIds.join(", ") : "none"}`,
		`No task was resumed automatically.`,
		`Resume intentionally with squad_modify { action: "resume_task", squadId: "${squad.id}", taskId: "<exact-task-id>" } for each task you choose.`,
	];
}
