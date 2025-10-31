import React from "react";
import stripAnsi from "strip-ansi";

type InkModule = typeof import("ink");

interface TerminalDisplayProps {
  ink: InkModule;
  lines: string[];
  width?: number;
  height?: number;
  focused?: boolean;
}

export const TerminalDisplay: React.FC<TerminalDisplayProps> = React.memo(({
  ink,
  lines,
  width,
  height = 20,
  focused = false,
}) => {
  const { Box, Text } = ink;

  // Show last N lines to fit the height
  const visibleLines = React.useMemo(() => {
    const visible = lines.slice(-height).map(line => stripAnsi(line));
    // Pad with empty lines if needed
    while (visible.length < height) {
      visible.push("");
    }
    return visible;
  }, [lines, height]);

  return (
    <Box
      flexDirection="column"
      borderStyle={focused ? "double" : "round"}
      borderColor={focused ? "green" : "gray"}
      width={width}
      height={height + 2} // +2 for border
      paddingX={1}
    >
      {visibleLines.map((line, index) => (
        <Text key={index}>{line || " "}</Text>
      ))}
    </Box>
  );
}, (prevProps, nextProps) => {
  // Custom comparison - only re-render if lines content or focus changed
  return (
    prevProps.focused === nextProps.focused &&
    prevProps.height === nextProps.height &&
    prevProps.width === nextProps.width &&
    prevProps.lines.length === nextProps.lines.length &&
    prevProps.lines[prevProps.lines.length - 1] === nextProps.lines[nextProps.lines.length - 1]
  );
});
