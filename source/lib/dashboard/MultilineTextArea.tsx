import { Box, Text, useInput } from "ink";

interface MultilineTextAreaProps {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
	placeholder?: string;
	width?: number;
	height?: number;
	focus?: boolean;
}

export function MultilineTextArea({
	value,
	onChange,
	onSubmit,
	onCancel,
	placeholder,
	width,
	height = 6,
	focus = true,
}: MultilineTextAreaProps) {
	useInput(
		(input, key) => {
			// Ctrl+D submits
			if (key.ctrl && input === "d") {
				onSubmit();
				return;
			}

			// ESC cancels. Parent disables SGR mouse tracking while this overlay is
			// mounted so clicks can no longer masquerade as ESC.
			if (key.escape) {
				onCancel();
				return;
			}

			if (key.backspace || key.delete) {
				onChange(value.slice(0, -1));
				return;
			}

			// Swallow navigation keys — this is an append-only text area.
			if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) return;

			// Enter inserts a newline. MUST run before the meta/ctrl swallow below so
			// Option+Enter and Ctrl+Enter also insert newlines. When Ink delivers a
			// paste as one chunk, `input` may carry embedded content alongside the
			// \r — normalize and append the whole thing instead of dropping it.
			if (key.return) {
				const chunk = input ? input.replace(/\r\n?/g, "\n") : "\n";
				onChange(value + chunk);
				return;
			}

			// Swallow remaining modifier combos.
			if (key.ctrl || key.meta) return;

			if (!input) return;

			// Pasted content may embed \r or \r\n — normalize to \n.
			const normalized = input.replace(/\r\n?/g, "\n");
			onChange(value + normalized);
		},
		{ isActive: focus },
	);

	const lines = value.length === 0 ? [""] : value.split("\n");
	const visibleLines = lines.slice(Math.max(0, lines.length - height));
	const isEmpty = value.length === 0;

	return (
		<Box
			flexDirection="column"
			width={width}
			borderStyle="round"
			borderColor="cyan"
			paddingX={1}
			minHeight={height + 2}
		>
			{isEmpty && placeholder ? (
				<Box minHeight={1}>
					<Text color="cyan">█</Text>
					<Text dimColor>{placeholder}</Text>
				</Box>
			) : (
				visibleLines.map((line, i) => {
					const isLast = i === visibleLines.length - 1;
					return (
						<Box key={i} minHeight={1}>
							<Text>{line}</Text>
							{isLast && focus ? <Text color="cyan">█</Text> : null}
						</Box>
					);
				})
			)}
		</Box>
	);
}
