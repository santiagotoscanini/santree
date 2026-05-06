import type { PRInfo, PRCheck, PRReview, PRConversationComment, SearchPR } from "../github.js";
import type { AssignedIssue } from "../trackers/types.js";

export type { AssignedIssue } from "../trackers/types.js";

export interface WorktreeInfo {
	path: string;
	branch: string;
	dirty: boolean;
	commitsAhead: number;
	sessionId: string | null;
	gitStatus: string;
	sessionState: "waiting" | "idle" | "active" | null;
	sessionMessage: string | null;
	diffStats: { filesChanged: number; insertions: number; deletions: number } | null;
}

export interface DashboardIssue {
	issue: AssignedIssue;
	worktree: WorktreeInfo | null;
	pr: PRInfo | null;
	checks: PRCheck[] | null;
	reviews: PRReview[] | null;
	parentTicketId?: string;
	children?: DashboardIssue[];
}

export interface StatusGroup {
	name: string;
	type: string;
	issues: DashboardIssue[];
}

export interface ProjectGroup {
	name: string;
	id: string | null;
	statusGroups: StatusGroup[];
}

export type ReviewPR = SearchPR;

export interface EnrichedReviewPR {
	pr: SearchPR;
	body: string | null;
	branch: string | null;
	baseBranch: string | null;
	additions: number;
	deletions: number;
	changedFiles: number;
	checks: PRCheck[] | null;
	reviews: PRReview[] | null;
	comments: PRConversationComment[] | null;
	worktree: WorktreeInfo | null;
}

export type DashboardTab = "issues" | "reviews";

export type ActionOverlay =
	| "mode-select"
	| "context-input"
	| "base-select"
	| "confirm-delete"
	| "confirm-setup"
	| "commit"
	| "pr-create"
	| "diff"
	| null;

export type DiffFileStatus = "M" | "A" | "D" | "R" | "C" | "U" | "?";

export interface DiffFile {
	path: string;
	status: DiffFileStatus;
	oldPath?: string; // for renames
	// Working-tree state from `git status --porcelain` — undefined when the file
	// has only committed changes vs base. Used for lazygit-style XY indicator
	// and to drive stage/unstage/discard actions.
	indexStatus?: string;
	workingStatus?: string;
	isUntracked?: boolean;
}

export type CommitPhase =
	| "idle"
	| "confirm-stage"
	| "awaiting-message"
	| "committing"
	| "pushing"
	| "done"
	| "error";

export type PrCreatePhase =
	| "idle"
	| "choose-mode"
	| "pushing"
	| "filling"
	| "review"
	| "confirm"
	| "creating"
	| "done"
	| "error";

export interface DashboardState {
	activeTab: DashboardTab;
	groups: ProjectGroup[];
	flatIssues: DashboardIssue[];
	selectedIndex: number;
	listScrollOffset: number;
	detailScrollOffset: number;
	flatReviews: EnrichedReviewPR[];
	reviewSelectedIndex: number;
	reviewListScrollOffset: number;
	reviewDetailScrollOffset: number;
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
	prCreateBody: string | null;
	prCreateTitle: string | null;
	setupMode: "plan" | "implement" | null;
	baseSelectOptions: string[];
	baseSelectIndex: number;
	baseSelectChosen: string | null;
	contextInputValue: string;
	contextInputMode: "plan" | "implement" | null;
	// Diff overlay
	diffTicketId: string | null;
	diffWorktreePath: string | null;
	diffBaseBranch: string | null;
	diffMergeBase: string | null;
	diffFiles: DiffFile[];
	diffFileIndex: number;
	diffFileScrollOffset: number;
	diffContent: string | null;
	diffContentScrollOffset: number;
	diffLoadingFiles: boolean;
	diffLoadingContent: boolean;
	diffError: string | null;
	diffPendingDiscard: { path: string; isUntracked: boolean } | null;
	// Bumped on DIFF_REFRESH_FILES to trigger a silent reload (no spinner) —
	// used by the periodic refresh tick and discard. Stage/unstage avoid this
	// path entirely and patch XY in place via DIFF_STATUS_UPDATED.
	diffRefreshTick: number;
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
	| { type: "PR_CREATE_REVIEW"; body: string; title: string }
	| { type: "PR_CREATE_BODY_CHANGE"; body: string }
	| { type: "PR_CREATE_CONFIRM" }
	| { type: "PR_CREATE_EDIT" }
	| { type: "PR_CREATE_DONE"; url: string }
	| { type: "PR_CREATE_CANCEL" }
	| { type: "SETUP_CONFIRM_SHOW"; mode: "plan" | "implement" }
	| { type: "SETUP_CONFIRM_DONE" }
	| { type: "BASE_SELECT_SHOW"; options: string[] }
	| { type: "BASE_SELECT_MOVE"; index: number }
	| { type: "BASE_SELECT_CONFIRM"; chosen: string }
	| { type: "BASE_SELECT_DONE" }
	| { type: "SET_TAB"; tab: DashboardTab }
	| { type: "SET_REVIEWS_DATA"; flatReviews: EnrichedReviewPR[] }
	| { type: "REVIEW_SELECT"; index: number }
	| { type: "REVIEW_SCROLL_LIST"; offset: number }
	| { type: "REVIEW_SCROLL_DETAIL"; offset: number }
	| { type: "CONTEXT_INPUT_SHOW"; mode: "plan" | "implement" }
	| { type: "CONTEXT_INPUT_CHANGE"; value: string }
	| { type: "CONTEXT_INPUT_DONE" }
	| {
			type: "DIFF_OPEN";
			ticketId: string;
			worktreePath: string;
			baseBranch: string;
	  }
	| { type: "DIFF_FILES_LOADED"; files: DiffFile[]; mergeBase: string }
	| { type: "DIFF_FILES_ERROR"; error: string }
	| { type: "DIFF_FILE_SELECT"; index: number }
	| { type: "DIFF_FILE_SCROLL"; offset: number }
	| { type: "DIFF_CONTENT_LOADING" }
	| { type: "DIFF_CONTENT_LOADED"; content: string }
	| { type: "DIFF_CONTENT_SCROLL"; offset: number }
	| { type: "DIFF_REFRESH_FILES" }
	| {
			type: "DIFF_STATUS_UPDATED";
			porcelain: { path: string; index: string; working: string }[];
	  }
	| { type: "DIFF_DISCARD_OPEN"; path: string; isUntracked: boolean }
	| { type: "DIFF_DISCARD_CANCEL" }
	| { type: "DIFF_CLOSE" };

// ── State management ──────────────────────────────────────────────────

export const initialState: DashboardState = {
	activeTab: "issues",
	groups: [],
	flatIssues: [],
	selectedIndex: 0,
	listScrollOffset: 0,
	detailScrollOffset: 0,
	flatReviews: [],
	reviewSelectedIndex: 0,
	reviewListScrollOffset: 0,
	reviewDetailScrollOffset: 0,
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
	prCreateBody: null,
	prCreateTitle: null,
	setupMode: null,
	baseSelectOptions: [],
	baseSelectIndex: 0,
	baseSelectChosen: null,
	contextInputValue: "",
	contextInputMode: null,
	diffTicketId: null,
	diffWorktreePath: null,
	diffBaseBranch: null,
	diffMergeBase: null,
	diffFiles: [],
	diffFileIndex: 0,
	diffFileScrollOffset: 0,
	diffContent: null,
	diffContentScrollOffset: 0,
	diffLoadingFiles: false,
	diffLoadingContent: false,
	diffError: null,
	diffPendingDiscard: null,
	diffRefreshTick: 0,
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
			return {
				...state,
				creatingForTicket: null,
				creationLogs: "",
				creationError: null,
				baseSelectChosen: null,
			};
		case "CREATION_ERROR":
			return {
				...state,
				creationError: action.error,
				creatingForTicket: null,
				creationLogs: "",
				baseSelectChosen: null,
			};
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
		case "PR_CREATE_REVIEW":
			return {
				...state,
				prCreatePhase: "review",
				prCreateBody: action.body,
				prCreateTitle: action.title,
				detailScrollOffset: 0,
			};
		case "PR_CREATE_BODY_CHANGE":
			return { ...state, prCreateBody: action.body };
		case "PR_CREATE_CONFIRM":
			return { ...state, prCreatePhase: "confirm" };
		case "PR_CREATE_EDIT":
			return { ...state, prCreatePhase: "review" };
		case "PR_CREATE_DONE":
			return {
				...state,
				prCreatePhase: "done",
				prCreateUrl: action.url,
				prCreateBody: null,
				prCreateTitle: null,
			};
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
				prCreateBody: null,
				prCreateTitle: null,
			};
		case "SETUP_CONFIRM_SHOW":
			return {
				...state,
				overlay: "confirm-setup",
				setupMode: action.mode,
			};
		case "SETUP_CONFIRM_DONE":
			return {
				...state,
				overlay: null,
				setupMode: null,
			};
		case "BASE_SELECT_SHOW":
			return {
				...state,
				overlay: "base-select",
				baseSelectOptions: action.options,
				baseSelectIndex: 0,
				baseSelectChosen: null,
			};
		case "BASE_SELECT_MOVE":
			return { ...state, baseSelectIndex: action.index };
		case "BASE_SELECT_CONFIRM":
			return {
				...state,
				overlay: null,
				baseSelectChosen: action.chosen,
			};
		case "BASE_SELECT_DONE":
			return {
				...state,
				overlay: null,
				baseSelectOptions: [],
				baseSelectIndex: 0,
			};
		case "SET_TAB":
			return { ...state, activeTab: action.tab };
		case "SET_REVIEWS_DATA": {
			const prevNum = state.flatReviews[state.reviewSelectedIndex]?.pr.number;
			let newIdx = 0;
			if (prevNum !== undefined) {
				const found = action.flatReviews.findIndex((p) => p.pr.number === prevNum);
				if (found >= 0) newIdx = found;
			}
			return {
				...state,
				flatReviews: action.flatReviews,
				reviewSelectedIndex: newIdx,
				reviewDetailScrollOffset: 0,
			};
		}
		case "REVIEW_SELECT":
			return { ...state, reviewSelectedIndex: action.index, reviewDetailScrollOffset: 0 };
		case "REVIEW_SCROLL_LIST":
			return { ...state, reviewListScrollOffset: action.offset };
		case "REVIEW_SCROLL_DETAIL":
			return { ...state, reviewDetailScrollOffset: action.offset };
		case "CONTEXT_INPUT_SHOW":
			return {
				...state,
				overlay: "context-input",
				contextInputMode: action.mode,
				contextInputValue: "",
			};
		case "CONTEXT_INPUT_CHANGE":
			return { ...state, contextInputValue: action.value };
		case "CONTEXT_INPUT_DONE":
			return {
				...state,
				overlay: null,
				contextInputMode: null,
				contextInputValue: "",
			};
		case "DIFF_OPEN":
			return {
				...state,
				overlay: "diff",
				diffTicketId: action.ticketId,
				diffWorktreePath: action.worktreePath,
				diffBaseBranch: action.baseBranch,
				diffMergeBase: null,
				diffFiles: [],
				diffFileIndex: 0,
				diffFileScrollOffset: 0,
				diffContent: null,
				diffContentScrollOffset: 0,
				diffLoadingFiles: true,
				diffLoadingContent: false,
				diffError: null,
				diffPendingDiscard: null,
				diffRefreshTick: 0,
			};
		case "DIFF_FILES_LOADED": {
			// Preserve the user's selection across reloads (after stage/unstage/
			// discard) by matching the previously-selected file's path. Falls back
			// to the clamped index when the path is gone (e.g. file was discarded).
			const prevPath = state.diffFiles[state.diffFileIndex]?.path;
			let newIndex = 0;
			if (prevPath) {
				const found = action.files.findIndex((f) => f.path === prevPath);
				if (found >= 0) newIndex = found;
				else newIndex = Math.min(state.diffFileIndex, Math.max(0, action.files.length - 1));
			}
			return {
				...state,
				diffFiles: action.files,
				diffMergeBase: action.mergeBase,
				diffFileIndex: newIndex,
				diffLoadingFiles: false,
				diffError: null,
			};
		}
		case "DIFF_REFRESH_FILES":
			// Silent re-fetch — bumps the tick the loader effect depends on,
			// without flipping diffLoadingFiles. The current file list stays
			// rendered until the new one arrives, so there's no spinner blink.
			return { ...state, diffRefreshTick: state.diffRefreshTick + 1 };
		case "DIFF_STATUS_UPDATED": {
			// In-place XY patch — used by stage/unstage where the file SET
			// doesn't change, only the per-file porcelain status. Avoids the
			// full reload's network/git latency and the spinner that goes
			// with it.
			const byPath = new Map<string, { index: string; working: string }>();
			for (const p of action.porcelain) byPath.set(p.path, p);
			const next = state.diffFiles.map((f) => {
				const p = byPath.get(f.path);
				if (!p) {
					// File no longer has any working-tree state — back to
					// committed-only. Strip the XY fields.
					if (f.indexStatus === undefined && f.workingStatus === undefined) return f;
					const cleared: DiffFile = { ...f };
					delete cleared.indexStatus;
					delete cleared.workingStatus;
					delete cleared.isUntracked;
					return cleared;
				}
				return {
					...f,
					indexStatus: p.index,
					workingStatus: p.working,
					isUntracked: p.index === "?" && p.working === "?",
				};
			});
			return { ...state, diffFiles: next };
		}
		case "DIFF_DISCARD_OPEN":
			return {
				...state,
				diffPendingDiscard: { path: action.path, isUntracked: action.isUntracked },
			};
		case "DIFF_DISCARD_CANCEL":
			return { ...state, diffPendingDiscard: null };
		case "DIFF_FILES_ERROR":
			return {
				...state,
				diffLoadingFiles: false,
				diffError: action.error,
			};
		case "DIFF_FILE_SELECT":
			return {
				...state,
				diffFileIndex: action.index,
				diffContentScrollOffset: 0,
			};
		case "DIFF_FILE_SCROLL":
			return { ...state, diffFileScrollOffset: action.offset };
		case "DIFF_CONTENT_LOADING":
			return { ...state, diffLoadingContent: true, diffContent: null };
		case "DIFF_CONTENT_LOADED":
			return {
				...state,
				diffContent: action.content,
				diffLoadingContent: false,
				diffContentScrollOffset: 0,
			};
		case "DIFF_CONTENT_SCROLL":
			return { ...state, diffContentScrollOffset: action.offset };
		case "DIFF_CLOSE":
			return {
				...state,
				overlay: null,
				diffTicketId: null,
				diffWorktreePath: null,
				diffBaseBranch: null,
				diffMergeBase: null,
				diffFiles: [],
				diffFileIndex: 0,
				diffFileScrollOffset: 0,
				diffContent: null,
				diffContentScrollOffset: 0,
				diffLoadingFiles: false,
				diffLoadingContent: false,
				diffError: null,
				diffPendingDiscard: null,
			};
		default:
			return state;
	}
}
