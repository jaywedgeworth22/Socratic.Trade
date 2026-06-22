"use client";

import { useEffect, useState } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  BackgroundVariant
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Database, Activity, ShieldAlert, Cpu, Network } from "lucide-react";

// Track the app's class-based dark mode so React Flow's chrome (controls, edges,
// background) themes with the rest of the cockpit instead of guessing from the OS.
function useColorMode(): "dark" | "light" {
  const [mode, setMode] = useState<"dark" | "light">("dark"); // default dark for SSR
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setMode(el.classList.contains("dark") ? "dark" : "light");
    update();
    const observer = new MutationObserver(update);
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return mode;
}

// Custom Node to fit the glassmorphic theme
const CustomNode = ({ data }: { data: any }) => {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-line/40 bg-surface/50 p-4 text-sm font-medium shadow-[var(--shadow-lg)] backdrop-blur-xl">
      <div className={`rounded-full p-2 text-white ${data.color || "bg-accent"}`}>
        {data.icon}
      </div>
      <div className="text-fg">{data.label}</div>
      {data.subtext && <div className="text-xs text-faint">{data.subtext}</div>}
    </div>
  );
};

const nodeTypes = {
  custom: CustomNode
};

export function StrategyFlow() {
  // Spaced out so the three source nodes (and their shadows) no longer overlap.
  const initialNodes = [
    {
      id: "1",
      type: "custom",
      position: { x: 60, y: 40 },
      data: { label: "SEC Filings", icon: <Database size={16} />, color: "bg-info", subtext: "10-K, 10-Q" }
    },
    {
      id: "2",
      type: "custom",
      position: { x: 60, y: 180 },
      data: { label: "Yahoo News", icon: <Activity size={16} />, color: "bg-info", subtext: "RSS Feeds" }
    },
    {
      id: "3",
      type: "custom",
      position: { x: 60, y: 320 },
      data: { label: "FRED Macro", icon: <Network size={16} />, color: "bg-info", subtext: "Rates, CPI" }
    },
    {
      id: "4",
      type: "custom",
      position: { x: 340, y: 180 },
      data: { label: "Pinecone Vector DB", icon: <Database size={16} />, color: "bg-accent", subtext: "Semantic Search" }
    },
    {
      id: "5",
      type: "custom",
      position: { x: 620, y: 70 },
      data: { label: "Evaluator Agent", icon: <Cpu size={16} />, color: "bg-warn", subtext: "Strategy Tuning" }
    },
    {
      id: "6",
      type: "custom",
      position: { x: 620, y: 260 },
      data: { label: "Trader Agent", icon: <Cpu size={16} />, color: "bg-up", subtext: "Execution Loop" }
    },
    {
      id: "7",
      type: "custom",
      position: { x: 900, y: 260 },
      data: { label: "Risk Manager", icon: <ShieldAlert size={16} />, color: "bg-down", subtext: "Position Sizing" }
    }
  ];

  // Stroke/marker/animation come from defaultEdgeOptions below so every edge is
  // visibly connected (the diagram previously rendered nodes with no edges).
  const initialEdges = [
    { id: "e1-4", source: "1", target: "4" },
    { id: "e2-4", source: "2", target: "4" },
    { id: "e3-4", source: "3", target: "4" },
    { id: "e4-5", source: "4", target: "5" },
    { id: "e4-6", source: "4", target: "6" },
    { id: "e5-6", source: "5", target: "6", label: "Updated Prompts" },
    { id: "e6-7", source: "6", target: "7" }
  ];

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);
  const colorMode = useColorMode();

  return (
    <div className="h-full w-full rounded-xl border border-line bg-surface/20 backdrop-blur-md">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: "smoothstep",
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed, color: "var(--accent)" },
          style: { stroke: "var(--accent)", strokeWidth: 1.5 }
        }}
        fitView
      >
        <Controls className="bg-surface border-line text-fg" />
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} color="var(--line-strong)" />
      </ReactFlow>
    </div>
  );
}
