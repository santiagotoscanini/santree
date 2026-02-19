import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import type { CommitPhase, PrCreatePhase, DashboardAction } from "./types.js";

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
			{phase === "awaiting-message" && (
				<Box>
					<Text>Message: </Text>
					<TextInput
						value={message}
						onChange={(v) => dispatch({ type: "COMMIT_MESSAGE", message: v })}
						onSubmit={onSubmit}
					/>
				</Box>
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
			<Text> </Text>
			<Text dimColor>ESC to cancel</Text>
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
}

export function PrCreateOverlay({
	width,
	height,
	branch,
	ticketId,
	phase,
	error,
	url,
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
						Fill — auto-fill title & body from commits
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
			{phase === "error" && <Text color="red">{error}</Text>}
			<Text> </Text>
			<Text dimColor>ESC to cancel</Text>
		</Box>
	);
}
