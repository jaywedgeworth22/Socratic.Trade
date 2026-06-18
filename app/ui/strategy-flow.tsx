"use client";

import React, { useMemo } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  BackgroundVariant
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Database, Activity, ShieldAlert, Cpu, Network } from "lucide-react";

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
  const initialNodes = [
    {
      id: "1",
      type: "custom",
      position: { x: 50, y: 50 },
      data: { label: "SEC Filings", icon: <Database size={16} />, color: "bg-info", subtext: "10-K, 10-Q" }
    },
    {
      id: "2",
      type: "custom",
      position: { x: 50, y: 150 },
      data: { label: "Yahoo News", icon: <Activity size={16} />, color: "bg-info", subtext: "RSS Feeds" }
    },
    {
      id: "3",
      type: "custom",
      position: { x: 50, y: 250 },
      data: { label: "FRED Macro", icon: <Network size={16} />, color: "bg-info", subtext: "Rates, CPI" }
    },
    {
      id: "4",
      type: "custom",
      position: { x: 300, y: 150 },
      data: { label: "Pinecone Vector DB", icon: <Database size={16} />, color: "bg-accent", subtext: "Semantic Search" }
    },
    {
      id: "5",
      type: "custom",
      position: { x: 550, y: 50 },
      data: { label: "Evaluator Agent", icon: <Cpu size={16} />, color: "bg-warn", subtext: "Strategy Tuning" }
    },
    {
      id: "6",
      type: "custom",
      position: { x: 550, y: 200 },
      data: { label: "Trader Agent", icon: <Cpu size={16} />, color: "bg-up", subtext: "Execution Loop" }
    },
    {
      id: "7",
      type: "custom",
      position: { x: 800, y: 200 },
      data: { label: "Risk Manager", icon: <ShieldAlert size={16} />, color: "bg-down", subtext: "Position Sizing" }
    }
  ];

  const initialEdges = [
    { id: "e1-4", source: "1", target: "4", animated: true },
    { id: "e2-4", source: "2", target: "4", animated: true },
    { id: "e3-4", source: "3", target: "4", animated: true },
    { id: "e4-5", source: "4", target: "5", animated: true },
    { id: "e4-6", source: "4", target: "6", animated: true },
    { id: "e5-6", source: "5", target: "6", animated: true, label: "Updated Prompts" },
    { id: "e6-7", source: "6", target: "7", animated: true, markerEnd: { type: MarkerType.ArrowClosed } }
  ];

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  return (
    <div className="h-full w-full rounded-xl border border-line bg-surface/20 backdrop-blur-md">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
      >
        <Controls className="bg-surface border-line text-fg" />
        <MiniMap
          nodeStrokeColor={(n) => {
            if (n.type === "custom") return "#cbd3dd";
            return "#eee";
          }}
          nodeColor={(n) => {
            if (n.type === "custom") return "#f4f6f9";
            return "#fff";
          }}
          className="bg-surface"
        />
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} color="var(--line-strong)" />
      </ReactFlow>
    </div>
  );
}
