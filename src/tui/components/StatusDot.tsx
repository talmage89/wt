import React from "react";
import { Text } from "ink";

export function StatusDot({ dirty }: { dirty: boolean }) {
  return <Text color={dirty ? "yellow" : "green"}>●</Text>;
}
