import { Box, Text, useInput } from "ink";

interface Props {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({ message, onConfirm, onCancel }: Props) {
  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      onConfirm();
    } else if (input === "n" || input === "N" || key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{message}</Text>
      <Text dimColor>Press [y]es or [n]o (Esc to cancel)</Text>
    </Box>
  );
}
