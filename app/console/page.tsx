"use client";

import { useConsoleData } from "./lib/useConsoleData";
import { Card, Empty } from "./ui/primitives";

export default function ConsoleHomePage() {
  const { snapshot } = useConsoleData();
  if (!snapshot) return null;
  return (
    <Card title="Home">
      <Empty>Home is under construction.</Empty>
    </Card>
  );
}
