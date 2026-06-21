import React from "react";
import { Box, Text } from "ink";

const FULL_LOGO = [
  "             /\\",
  "        ____/  \\____",
  "       /   /|  |\\   \\",
  "      / C / |  | \\ S \\",
  "      \\  /  |  |  \\  /",
  "       \\____|/\\|____/",
  "            CARIS",
];

export function CarisLogo({
  project,
  width = process.stdout.columns ?? 80,
}: {
  project: string;
  width?: number;
}): React.JSX.Element {
  if (width < 58) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="#4C8DFF">CARIS</Text>
        <Text dimColor>{project}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      {FULL_LOGO.map((line, index) => (
        <Text key={`${index}-${line}`} bold color={index === FULL_LOGO.length - 1 ? "#E5A84B" : "#4C8DFF"}>
          {line}
        </Text>
      ))}
      <Text bold>CLI AGENT ROUTING AND INTEGRATION SYSTEM</Text>
      <Text dimColor>Project: {project}</Text>
    </Box>
  );
}
