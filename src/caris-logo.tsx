import { readFileSync } from "node:fs";
import React from "react";
import { Box, Text } from "ink";
import { CARIS_VERSION } from "./version.js";

const LOGO_COLOR = "#1E90FF";
const FULL_LOGO_MIN_WIDTH = 106;
const logoSource = new URL("../assets/caris_logo_ascii.txt", import.meta.url);

export function CarisLogo({
  project,
  width = process.stdout.columns ?? 80,
  version = CARIS_VERSION,
}: {
  project: string;
  width?: number;
  version?: string;
}): React.JSX.Element {
  const footer = (
    <>
      <Text>CARIS: CLI Agent Routing and Integration System</Text>
      <Text>V.{version}</Text>
      <Text>{project}</Text>
    </>
  );
  if (width < FULL_LOGO_MIN_WIDTH) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={LOGO_COLOR}>CARIS</Text>
        {footer}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      {readLogoArt().map((line, index) => <Text key={`${index}-${line}`} color={LOGO_COLOR}>{line}</Text>)}
      {footer}
    </Box>
  );
}

export function readLogoArt(): string[] {
  try {
    const lines = readFileSync(logoSource, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
    const footerIndex = lines.findIndex((line) => line.includes("CARIS: CLI Agent Routing"));
    return lines
      .slice(0, footerIndex >= 0 ? footerIndex : lines.length)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
  } catch {
    return ["CARIS"];
  }
}
