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
			if (key.escape) {
				onCancel();
				return;
			}

			// Ctrl+D submits (empty or not)
			if (key.ctrl && input === "d") {
				onSubmit();
				return;
			}

			if (key.backspace || key.delete) {
				onChange(value.slice(0, -1));
				return;
			}

			// Swallow arrow/tab navigation to avoid stray characters
			if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) return;

			// Meta combos — ignore
			if (key.meta || (key.ctrl && !key.return)) return;

			// Enter inserts a newline. Some terminals deliver "\r" as input with
			// key.return; we always normalize to "\n".
			if (key.return) {
				onChange(value + "\n");
				return;
			}

			if (!input) return;

			// Pasted content may embed \r or \r\n — normalize to \n
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
				<Box>
					<Text dimColor>{placeholder}</Text>
					<Text color="cyan">█</Text>
				</Box>
			) : (
				visibleLines.map((line, i) => {
					const isLast = i === visibleLines.length - 1;
					return (
						<Box key={i}>
							<Text>{line}</Text>
							{isLast && focus ? <Text color="cyan">█</Text> : null}
						</Box>
					);
				})
			)}
		</Box>
	);
}
