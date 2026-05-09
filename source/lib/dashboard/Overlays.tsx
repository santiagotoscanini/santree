import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { CommitPhase, PrCreatePhase, DashboardAction } from "./types.js";
import { MultilineTextArea } from "./MultilineTextArea.js";

// ── Commit Overlay ───────────────────────────────────────────────────

interface CommitOverlayProps {
	width: number;
	height: number;
	branch: string | null;
	ticketId: string | null;
	gitStatus: string;
	phase: CommitPhase;
	message: string;
	error: string | null;
	dispatch: React.Dispatch<DashboardAction>;
	onSubmit: (value: string) => void;
}

export function CommitOverlay({
	width,
	height,
	branch,
	ticketId,
	gitStatus,
	phase,
	message,
	error,
	dispatch,
	onSubmit,
}: CommitOverlayProps) {
	return (
		<Box flexDirection="column" width={width} height={height}>
			<Text bold color="cyan">
				Commit & Push
			</Text>
			<Text dimColor>{"─".repeat(Math.min(width, 50))}</Text>
			<Text>
				<Text dimColor>branch: </Text>
				<Text>{branch}</Text>
			</Text>
			<Text>
				<Text dimColor>ticket: </Text>
				<Text>{ticketId}</Text>
			</Text>
			<Text> </Text>
			{gitStatus ? (
				<>
					<Text dimColor>Changes:</Text>
					{gitStatus
						.split("\n")
						.slice(0, 8)
						.map((line, i) => {
							let color: string | undefined;
							if (line.length >= 2 && line[0] !== " " && line[0] !== "?") {
								color = "green";
							} else if (line.startsWith("??")) {
								color = "gray";
							} else if (line.startsWith(" ")) {
								color = "yellow";
							}
							return (
								<Text key={i} color={color as any}>
									{" "}
									{line}
								</Text>
							);
						})}
					{gitStatus.split("\n").length > 8 && (
						<Text dimColor> +{gitStatus.split("\n").length - 8} more</Text>
					)}
				</>
			) : null}
			<Text> </Text>
			{phase === "confirm-stage" && (
				<Text>
					Stage all changes?{" "}
					<Text color="cyan" bold>
						y
					</Text>
					/
					<Text color="cyan" bold>
						n
					</Text>
				</Text>
			)}
			{phase === "choose-mode" && (
				<>
					<Text bold>How do you want to write the message?</Text>
					<Text> </Text>
					<Text>
						{" "}
						<Text color="cyan" bold>
							f
						</Text>{" "}
						Fill — let Claude draft a short message
					</Text>
					<Text>
						{" "}
						<Text color="cyan" bold>
							m
						</Text>{" "}
						Manual — type it yourself
					</Text>
				</>
			)}
			{phase === "filling" && (
				<Text>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>{" "}
					Drafting commit message with Claude...
				</Text>
			)}
			{phase === "awaiting-message" && (
				<>
					<Text bold>Edit commit message</Text>
					<Text> </Text>
					<MultilineTextArea
						value={message}
						onChange={(v) => dispatch({ type: "COMMIT_MESSAGE", message: v })}
						onSubmit={() => onSubmit(message)}
						onCancel={() => dispatch({ type: "COMMIT_CANCEL" })}
						width={width}
						height={Math.max(3, Math.min(6, height - 12))}
						placeholder="(empty)"
					/>
					<Text> </Text>
					<Text dimColor>
						<Text color="cyan" bold>
							Ctrl+D
						</Text>
						{" commit  ·  "}
						<Text color="cyan" bold>
							Ctrl+O
						</Text>
						{" editor  ·  "}
						<Text color="cyan" bold>
							Ctrl+G
						</Text>
						{" cancel"}
					</Text>
				</>
			)}
			{phase === "committing" && (
				<Text>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>{" "}
					Committing...
				</Text>
			)}
			{phase === "pushing" && (
				<Text>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>{" "}
					Pushing...
				</Text>
			)}
			{phase === "done" && (
				<Text color="green" bold>
					Committed and pushed!
				</Text>
			)}
			{phase === "error" && <Text color="red">{error}</Text>}
			{phase !== "awaiting-message" && phase !== "done" && phase !== "error" && (
				<>
					<Text> </Text>
					<Text dimColor>ESC to cancel</Text>
				</>
			)}
		</Box>
	);
}

// ── PR Create Overlay ────────────────────────────────────────────────

interface PrCreateOverlayProps {
	width: number;
	height: number;
	branch: string | null;
	ticketId: string | null;
	phase: PrCreatePhase;
	error: string | null;
	url: string | null;
	body: string | null;
	title: string | null;
	dispatch: React.Dispatch<DashboardAction>;
}

export function PrCreateOverlay({
	width,
	height,
	branch,
	ticketId,
	phase,
	error,
	url,
	body,
	title,
	dispatch,
}: PrCreateOverlayProps) {
	return (
		<Box flexDirection="column" width={width} height={height}>
			<Text bold color="cyan">
				Create Pull Request
			</Text>
			<Text dimColor>{"─".repeat(Math.min(width, 50))}</Text>
			<Text>
				<Text dimColor>branch: </Text>
				<Text>{branch}</Text>
			</Text>
			<Text>
				<Text dimColor>ticket: </Text>
				<Text>{ticketId}</Text>
			</Text>
			<Text> </Text>
			{phase === "choose-mode" && (
				<>
					<Text bold>How do you want to create this PR?</Text>
					<Text> </Text>
					<Text>
						{" "}
						<Text color="cyan" bold>
							f
						</Text>{" "}
						Fill — use AI to fill the PR template
					</Text>
					<Text>
						{" "}
						<Text color="cyan" bold>
							w
						</Text>{" "}
						Web — open in browser to edit manually
					</Text>
				</>
			)}
			{phase === "pushing" && (
				<Text>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>{" "}
					Pushing branch...
				</Text>
			)}
			{phase === "filling" && (
				<Text>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>{" "}
					Filling PR template with AI...
				</Text>
			)}
			{phase === "review" && (
				<>
					<Text bold>Edit PR description</Text>
					<Text> </Text>
					<Text>
						<Text dimColor>title: </Text>
						<Text>{title}</Text>
					</Text>
					<Text> </Text>
					<MultilineTextArea
						value={body ?? ""}
						onChange={(v) => dispatch({ type: "PR_CREATE_BODY_CHANGE", body: v })}
						onSubmit={() => dispatch({ type: "PR_CREATE_CONFIRM" })}
						onCancel={() => dispatch({ type: "PR_CREATE_CANCEL" })}
						width={width}
						height={Math.max(6, height - 10)}
						placeholder="(empty PR body)"
					/>
					<Text> </Text>
					<Text dimColor>
						<Text color="cyan" bold>
							Ctrl+D
						</Text>
						{" send  ·  "}
						<Text color="cyan" bold>
							Ctrl+O
						</Text>
						{" editor  ·  "}
						<Text color="cyan" bold>
							Ctrl+G
						</Text>
						{" cancel"}
					</Text>
				</>
			)}
			{phase === "confirm" && (
				<>
					<Text bold>Create this PR?</Text>
					<Text> </Text>
					<Text>
						<Text dimColor>title: </Text>
						<Text>{title}</Text>
					</Text>
					<Text> </Text>
					<Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
						{(body ?? "")
							.split("\n")
							.slice(0, Math.max(4, height - 12))
							.map((line, i) => (
								<Text key={i} wrap="truncate">
									{line || " "}
								</Text>
							))}
						{(body ?? "").split("\n").length > Math.max(4, height - 12) && (
							<Text dimColor>
								…+{(body ?? "").split("\n").length - Math.max(4, height - 12)} more lines
							</Text>
						)}
					</Box>
					<Text> </Text>
					<Text>
						<Text color="green" bold>
							y
						</Text>
						{" / "}
						<Text color="green" bold>
							Enter
						</Text>
						{"  create   "}
						<Text color="yellow" bold>
							e
						</Text>
						{"  keep editing   "}
						<Text color="cyan" bold>
							w
						</Text>
						{"  open in browser   "}
						<Text color="red" bold>
							ESC
						</Text>
						{"  cancel"}
					</Text>
				</>
			)}
			{phase === "creating" && (
				<Text>
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>{" "}
					Creating PR...
				</Text>
			)}
			{phase === "done" && (
				<>
					<Text color="green" bold>
						PR created!
					</Text>
					{url ? <Text dimColor>{url}</Text> : null}
				</>
			)}
			{phase === "error" && (
				<>
					<Text color="red">{error}</Text>
					<Text> </Text>
					<Text dimColor>
						<Text color="cyan" bold>
							w
						</Text>{" "}
						open in browser ESC cancel
					</Text>
				</>
			)}
			{phase !== "review" && phase !== "confirm" && phase !== "error" && (
				<>
					<Text> </Text>
					<Text dimColor>ESC to cancel</Text>
				</>
			)}
		</Box>
	);
}

// ── Help Overlay ─────────────────────────────────────────────────────
// Centralized legend for every glyph the dashboard uses, so the rest of
// the UI can stay dense without becoming inscrutable. Sections mirror
// the panes (left list / right detail) so users can find a glyph by
// where they saw it.

type LegendRow = { glyph: string; color?: string; meaning: string };
type LegendSection = { title: string; rows: LegendRow[] };

const LEGEND: LegendSection[] = [
	{
		title: "Issue list",
		rows: [
			{ glyph: "▎", color: "red", meaning: "Urgent (P1) priority" },
			{ glyph: "▎", color: "yellow", meaning: "High (P2) priority" },
			{ glyph: "●", color: "green", meaning: "State: started / In Progress" },
			{ glyph: "●", color: "blue", meaning: "State: unstarted / In Review" },
			{ glyph: "●", color: "gray", meaning: "State: backlog / orphaned" },
			{ glyph: "●", color: "magenta", meaning: "State: main repo (your non-worktree checkout)" },
			{ glyph: "✓", color: "green", meaning: "WT column: worktree exists" },
			{ glyph: "·", color: "gray", meaning: "WT column: no worktree" },
			{ glyph: "✓", color: "green", meaning: "CI column: all checks passing" },
			{ glyph: "✗", color: "red", meaning: "CI column: a check is failing" },
			{ glyph: "●", color: "yellow", meaning: "CI column: checks pending / running" },
			{ glyph: "·", color: "gray", meaning: "CI column: no PR or no checks" },
		],
	},
	{
		title: "Detail panel — Worktree",
		rows: [
			{ glyph: "● dirty", color: "yellow", meaning: "Uncommitted changes" },
			{ glyph: "✓ clean", color: "green", meaning: "Working tree clean" },
			{ glyph: "↑ N", color: "cyan", meaning: "N commits ahead of base" },
			{ glyph: "↓ N behind", color: "yellow", meaning: "Main repo: N commits to pull from origin" },
			{ glyph: "◆", color: "red", meaning: "Session needs input (permission prompt)" },
			{ glyph: "◆", color: "green", meaning: "Session active (Claude is working)" },
			{ glyph: "◆", color: "yellow", meaning: "Session idle (waiting for prompt)" },
			{ glyph: "◇", color: "cyan", meaning: "Session id stored, no live signal" },
			{ glyph: "◇", color: "gray", meaning: "No session" },
		],
	},
	{
		title: "Detail panel — Tasks (Claude todos)",
		rows: [
			{ glyph: "◐", color: "yellow", meaning: "Task in progress" },
			{ glyph: "◯", color: "gray", meaning: "Task pending" },
			{ glyph: "✓", color: "green", meaning: "Task completed" },
		],
	},
	{
		title: "Section icons",
		rows: [
			{ glyph: "⎇", color: "cyan", meaning: "Worktree / Branch" },
			{ glyph: "◉", color: "cyan", meaning: "Pull Request" },
			{ glyph: "✓", color: "cyan", meaning: "Checks" },
			{ glyph: "★", color: "cyan", meaning: "Reviews" },
			{ glyph: "⎈", color: "cyan", meaning: "Tasks (Claude todos)" },
			{ glyph: "◎", color: "cyan", meaning: "Linked tracker ticket (review tab)" },
		],
	},
];

interface HelpOverlayProps {
	width: number;
	height: number;
}

export function HelpOverlay({ width, height }: HelpOverlayProps) {
	const lines: {
		text: string;
		segments?: { text: string; color?: string; bold?: boolean; dim?: boolean }[];
		bold?: boolean;
		dim?: boolean;
	}[] = [];

	for (const section of LEGEND) {
		lines.push({ text: section.title, bold: true });
		for (const row of section.rows) {
			lines.push({
				text: "",
				segments: [
					{ text: "  " },
					{ text: row.glyph.padEnd(3, " "), color: row.color, bold: true },
					{ text: "  " },
					{ text: row.meaning, dim: true },
				],
			});
		}
		lines.push({ text: "" });
	}

	// Trim trailing blank
	if (lines[lines.length - 1]?.text === "") lines.pop();

	return (
		<Box
			width={width}
			height={height}
			flexDirection="column"
			alignItems="center"
			justifyContent="center"
		>
			<Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={3} paddingY={1}>
				<Text bold color="cyan">
					Dashboard glyph reference
				</Text>
				<Text> </Text>
				{lines.map((line, i) => (
					<Box key={i}>
						{line.segments ? (
							<Text>
								{line.segments.map((seg, j) => (
									<Text key={j} color={seg.color} bold={seg.bold} dimColor={seg.dim}>
										{seg.text}
									</Text>
								))}
							</Text>
						) : (
							<Text bold={line.bold} dimColor={line.dim}>
								{line.text || " "}
							</Text>
						)}
					</Box>
				))}
				<Text> </Text>
				<Text dimColor>Press ? or Esc to close</Text>
			</Box>
		</Box>
	);
}
