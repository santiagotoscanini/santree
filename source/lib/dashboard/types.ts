import type { PRInfo, PRCheck, PRReview } from "../github.js";

export interface LinearAssignedIssue {
	identifier: string;
	title: string;
	description: string | null;
	url: string;
	priority: number;
	priorityLabel: string;
	state: { name: string; type: string };
	labels: string[];
	projectId: string | null;
	projectName: string | null;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	dirty: boolean;
	commitsAhead: number;
	sessionId: string | null;
	gitStatus: string;
}

export interface DashboardIssue {
	issue: LinearAssignedIssue;
	worktree: WorktreeInfo | null;
	pr: PRInfo | null;
	checks: PRCheck[] | null;
	reviews: PRReview[] | null;
}

export interface ProjectGroup {
	name: string;
	id: string | null;
	issues: DashboardIssue[];
}

export type ActionOverlay = "mode-select" | "confirm-delete" | "commit" | "pr-create" | null;

export type CommitPhase =
	| "idle"
	| "confirm-stage"
	| "awaiting-message"
	| "committing"
	| "pushing"
	| "done"
	| "error";

export type PrCreatePhase = "idle" | "choose-mode" | "pushing" | "creating" | "done" | "error";

export interface DashboardState {
	groups: ProjectGroup[];
	flatIssues: DashboardIssue[];
	selectedIndex: number;
	listScrollOffset: number;
	detailScrollOffset: number;
	loading: boolean;
	refreshing: boolean;
	error: string | null;
	overlay: ActionOverlay;
	actionMessage: string | null;
	creatingForTicket: string | null;
	creationLogs: string;
	creationError: string | null;
	deletingForTicket: string | null;
	commitPhase: CommitPhase;
	commitMessage: string;
	commitError: string | null;
	commitTicketId: string | null;
	commitWorktreePath: string | null;
	commitBranch: string | null;
	commitGitStatus: string;
	prCreatePhase: PrCreatePhase;
	prCreateTicketId: string | null;
	prCreateWorktreePath: string | null;
	prCreateBranch: string | null;
	prCreateError: string | null;
	prCreateUrl: string | null;
}

export type DashboardAction =
	| { type: "SET_DATA"; groups: ProjectGroup[]; flatIssues: DashboardIssue[] }
	| { type: "SELECT"; index: number }
	| { type: "SCROLL_LIST"; offset: number }
	| { type: "SCROLL_DETAIL"; offset: number }
	| { type: "REFRESH_START" }
	| { type: "REFRESH_DONE" }
	| { type: "SET_ERROR"; error: string }
	| { type: "SET_OVERLAY"; overlay: ActionOverlay }
	| { type: "SET_ACTION_MESSAGE"; message: string | null }
	| { type: "CLEAR_ERROR" }
	| { type: "CREATION_START"; ticketId: string }
	| { type: "CREATION_LOG"; logs: string }
	| { type: "CREATION_DONE" }
	| { type: "CREATION_ERROR"; error: string }
	| { type: "DELETE_START"; ticketId: string }
	| { type: "DELETE_DONE" }
	| {
			type: "COMMIT_START";
			ticketId: string;
			worktreePath: string;
			branch: string;
			gitStatus: string;
	  }
	| { type: "COMMIT_PHASE"; phase: CommitPhase }
	| { type: "COMMIT_MESSAGE"; message: string }
	| { type: "COMMIT_ERROR"; error: string }
	| { type: "COMMIT_DONE" }
	| { type: "COMMIT_CANCEL" }
	| { type: "PR_CREATE_START"; ticketId: string; worktreePath: string; branch: string }
	| { type: "PR_CREATE_PHASE"; phase: PrCreatePhase }
	| { type: "PR_CREATE_ERROR"; error: string }
	| { type: "PR_CREATE_DONE"; url: string }
	| { type: "PR_CREATE_CANCEL" };

// ── State management ──────────────────────────────────────────────────

export const initialState: DashboardState = {
	groups: [],
	flatIssues: [],
	selectedIndex: 0,
	listScrollOffset: 0,
	detailScrollOffset: 0,
	loading: true,
	refreshing: false,
	error: null,
	overlay: null,
	actionMessage: null,
	creatingForTicket: null,
	creationLogs: "",
	creationError: null,
	deletingForTicket: null,
	commitPhase: "idle",
	commitMessage: "",
	commitError: null,
	commitTicketId: null,
	commitWorktreePath: null,
	commitBranch: null,
	commitGitStatus: "",
	prCreatePhase: "idle",
	prCreateTicketId: null,
	prCreateWorktreePath: null,
	prCreateBranch: null,
	prCreateError: null,
	prCreateUrl: null,
};

export function reducer(state: DashboardState, action: DashboardAction): DashboardState {
	switch (action.type) {
		case "SET_DATA": {
			// Preserve selection by identifier if possible
			const prevId = state.flatIssues[state.selectedIndex]?.issue.identifier;
			let newIndex = 0;
			if (prevId) {
				const found = action.flatIssues.findIndex((d) => d.issue.identifier === prevId);
				if (found >= 0) newIndex = found;
			}
			return {
				...state,
				groups: action.groups,
				flatIssues: action.flatIssues,
				selectedIndex: newIndex,
				loading: false,
				refreshing: false,
				error: null,
				detailScrollOffset: 0,
			};
		}
		case "SELECT":
			return { ...state, selectedIndex: action.index, detailScrollOffset: 0 };
		case "SCROLL_LIST":
			return { ...state, listScrollOffset: action.offset };
		case "SCROLL_DETAIL":
			return { ...state, detailScrollOffset: action.offset };
		case "REFRESH_START":
			return { ...state, refreshing: true };
		case "REFRESH_DONE":
			return { ...state, refreshing: false };
		case "SET_ERROR":
			return { ...state, error: action.error, loading: false, refreshing: false };
		case "SET_OVERLAY":
			return { ...state, overlay: action.overlay };
		case "SET_ACTION_MESSAGE":
			return { ...state, actionMessage: action.message };
		case "CLEAR_ERROR":
			return { ...state, error: null };
		case "CREATION_START":
			return {
				...state,
				creatingForTicket: action.ticketId,
				creationLogs: "",
				creationError: null,
			};
		case "CREATION_LOG":
			return { ...state, creationLogs: state.creationLogs + action.logs };
		case "CREATION_DONE":
			return { ...state, creatingForTicket: null, creationLogs: "", creationError: null };
		case "CREATION_ERROR":
			return { ...state, creationError: action.error, creatingForTicket: null, creationLogs: "" };
		case "DELETE_START":
			return { ...state, deletingForTicket: action.ticketId };
		case "DELETE_DONE":
			return { ...state, deletingForTicket: null };
		case "COMMIT_START":
			return {
				...state,
				overlay: "commit",
				commitPhase: "confirm-stage",
				commitMessage: "",
				commitError: null,
				commitTicketId: action.ticketId,
				commitWorktreePath: action.worktreePath,
				commitBranch: action.branch,
				commitGitStatus: action.gitStatus,
			};
		case "COMMIT_PHASE":
			return { ...state, commitPhase: action.phase };
		case "COMMIT_MESSAGE":
			return { ...state, commitMessage: action.message };
		case "COMMIT_ERROR":
			return { ...state, commitPhase: "error", commitError: action.error };
		case "COMMIT_DONE":
			return { ...state, commitPhase: "done" };
		case "COMMIT_CANCEL":
			return {
				...state,
				overlay: null,
				commitPhase: "idle",
				commitMessage: "",
				commitError: null,
				commitTicketId: null,
				commitWorktreePath: null,
				commitBranch: null,
				commitGitStatus: "",
			};
		case "PR_CREATE_START":
			return {
				...state,
				overlay: "pr-create",
				prCreatePhase: "choose-mode",
				prCreateTicketId: action.ticketId,
				prCreateWorktreePath: action.worktreePath,
				prCreateBranch: action.branch,
				prCreateError: null,
				prCreateUrl: null,
			};
		case "PR_CREATE_PHASE":
			return { ...state, prCreatePhase: action.phase };
		case "PR_CREATE_ERROR":
			return { ...state, prCreatePhase: "error", prCreateError: action.error };
		case "PR_CREATE_DONE":
			return { ...state, prCreatePhase: "done", prCreateUrl: action.url };
		case "PR_CREATE_CANCEL":
			return {
				...state,
				overlay: null,
				prCreatePhase: "idle",
				prCreateTicketId: null,
				prCreateWorktreePath: null,
				prCreateBranch: null,
				prCreateError: null,
				prCreateUrl: null,
			};
		default:
			return state;
	}
}
