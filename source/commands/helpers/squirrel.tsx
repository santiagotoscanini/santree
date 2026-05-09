import { Box, useApp, useInput } from "ink";
import SquirrelLoader from "../../lib/squirrel-loader.js";

export const description = "Render the spinning squirrel until you Ctrl+C (debug helper)";

export default function Squirrel() {
	const { exit } = useApp();
	useInput((_, key) => {
		if (key.escape) exit();
	});
	return (
		<Box flexDirection="column" alignItems="center" paddingY={1}>
			<SquirrelLoader text="Press Esc or Ctrl+C to exit" />
		</Box>
	);
}
