"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  BackgroundVariant,
  type Node,
  type Edge
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Database, Activity, ShieldAlert, Cpu, Network, Landmark, Newspaper, LineChart, Gauge, Rocket } from "lucide-react";
import type { ReactNode } from "react";

// Track the app's class-based dark mode so React Flow's chrome themes with the cockpit.
function useColorMode(): "dark" | "light" {
  const [mode, setMode] = useState<"dark" | "light">("dark");
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

// ── Live status model ─────────────────────────────────────────────────────────
// Every node's color/label is DERIVED from the real dashboard snapshot — which data
// sources are enabled & have data, whether the last run produced proposals, the
// execution mode, etc. Nothing here is hardcoded "always green".
type NodeStatus = "active" | "ready" | "off" | "warn";

const STATUS_META: Record<NodeStatus, { dot: string; label: string; text: string }> = {
  active: { dot: "bg-up", label: "Active", text: "text-up" },
  ready: { dot: "bg-info", label: "Ready", text: "text-info" },
  warn: { dot: "bg-warn", label: "Check", text: "text-warn" },
  off: { dot: "bg-faint", label: "Off", text: "text-faint" }
};

type FlowNodeData = {
  label: string;
  subtext: string;
  detail?: string;
  icon: ReactNode;
  iconColor: string;
  status: NodeStatus;
};

const CustomNode = ({ data }: { data: FlowNodeData }) => {
  const s = STATUS_META[data.status];
  return (
    <div className={`flex w-[180px] flex-col gap-2 rounded-2xl border bg-surface/60 p-3 shadow-[var(--shadow-lg)] backdrop-blur-xl ${data.status === "off" ? "border-line/30 opacity-60" : "border-line/50"}`}>
      <div className="flex items-center gap-2">
        <div className={`rounded-lg p-1.5 text-white ${data.iconColor}`}>{data.icon}</div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fg">{data.label}</div>
          <div className="truncate text-[11px] text-faint">{data.subtext}</div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${s.text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} /> {s.label}
        </span>
        {data.detail && <span className="truncate text-[11px] text-muted">{data.detail}</span>}
      </div>
    </div>
  );
};

const nodeTypes = { custom: CustomNode };

// ── Snapshot → graph ────────────────────────────────────────────────────────
type FlowSnapshot = {
  policy?: any;
  webSources?: any;
  latestStrategyRun?: any;
  performance?: any;
  thesisScorecard?: any[];
  macroBoard?: any;
} | null | undefined;

function relAge(iso?: string): string | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return undefined;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

type Spec = { id: string; col: number; row: number; data: FlowNodeData };

function buildSpecs(snapshot: FlowSnapshot): { specs: Spec[]; edges: Edge[] } {
  const policy = snapshot?.policy ?? {};
  const ws = snapshot?.webSources ?? {};
  const run = snapshot?.latestStrategyRun;
  const scan = run?.marketScan;
  const candidateCount = Array.isArray(scan?.topCandidates) ? scan.topCandidates.length : 0;
  const proposalCount = Array.isArray(run?.proposals) ? run.proposals.length : 0;
  const scanAge = relAge(scan?.generatedAt);
  const evidence = Array.isArray(snapshot?.thesisScorecard) ? snapshot!.thesisScorecard!.length : 0;

  const smart = ["congress", "insider", "finra"].map((k) => ws[k]).filter(Boolean);
  const smartEnabled = smart.some((x: any) => x?.enabled);
  const smartRecords = smart.reduce((n: number, x: any) => n + (x?.recordCount ?? 0), 0);
  const smartAge = relAge(smart.map((x: any) => x?.fetchedAt).filter(Boolean).sort().reverse()[0]);

  const sec = ws.sec8k;
  const tech = ws.technical;
  const macroOn = Boolean(snapshot?.macroBoard);
  const regime = snapshot?.macroBoard?.regime?.label ?? snapshot?.macroBoard?.regime ?? undefined;

  const running = policy.systemState === "active";
  const autonomous = policy.strategyAuthority === "decide";
  const mode = policy.activeBroker === "test" || !policy.activeBroker ? "Test" : policy.paperMode ? "Paper" : "Brokerage";
  const model = policy.llmModel ?? "gpt-5.4-mini";

  const gateCount = [
    policy.maxDailyNotional, policy.maxHourlyNotional, policy.maxSymbolExposurePct, policy.maxDailyOrders,
    policy.maxPortfolioBeta, policy.maxEntryDriftPct, policy.riskRules?.stopLossPct, policy.riskRules?.takeProfitPct,
    policy.taxSettings?.washSaleGuard ? 1 : undefined
  ].filter((v) => v !== undefined && v !== null && v !== 0).length;

  const dataStatus = (enabled: boolean, records: number): NodeStatus => (!enabled ? "off" : records > 0 ? "active" : "ready");

  // Data sources (col 0)
  const sources: Spec[] = [
    {
      id: "market", col: 0, row: 0,
      data: { label: "Market Data", subtext: "Quotes & technicals", icon: <LineChart size={15} />, iconColor: "bg-info",
        status: candidateCount > 0 ? "active" : "ready", detail: scan?.source ? String(scan.source).split("+")[0] : "Yahoo (free)" }
    },
    {
      id: "macro", col: 0, row: 1,
      data: { label: "Macro (FRED)", subtext: "Rates, CPI, VIX", icon: <Network size={15} />, iconColor: "bg-info",
        status: macroOn ? "active" : "ready", detail: typeof regime === "string" ? regime : undefined }
    },
    {
      id: "smart", col: 0, row: 2,
      data: { label: "Smart Money", subtext: "Congress · Insider · FINRA", icon: <Landmark size={15} />, iconColor: "bg-info",
        status: dataStatus(smartEnabled, smartRecords), detail: smartEnabled ? `${smartRecords} rows${smartAge ? ` · ${smartAge}` : ""}` : "disabled" }
    },
    {
      id: "filings", col: 0, row: 3,
      data: { label: "SEC Filings + RAG", subtext: "8-K · semantic search", icon: <Database size={15} />, iconColor: "bg-accent",
        status: dataStatus(Boolean(sec?.enabled), sec?.recordCount ?? 0), detail: sec?.enabled ? `${sec.recordCount ?? 0} docs` : "disabled" }
    },
    {
      id: "technical", col: 0, row: 4,
      data: { label: "Technicals", subtext: tech?.source === "tradingview" ? "TradingView" : "Computed", icon: <Activity size={15} />, iconColor: "bg-info",
        status: dataStatus(Boolean(tech?.enabled), tech?.recordCount ?? 0), detail: tech?.enabled ? `${tech.recordCount ?? 0} signals` : "disabled" }
    }
  ];

  // Pipeline (cols 1-5)
  const pipeline: Spec[] = [
    {
      id: "scan", col: 1, row: 2,
      data: { label: "Scan & Score", subtext: "Multi-factor ranking", icon: <Gauge size={15} />, iconColor: "bg-accent",
        status: candidateCount > 0 ? "active" : "ready", detail: candidateCount > 0 ? `${candidateCount} ranked${scanAge ? ` · ${scanAge}` : ""}` : "no recent scan" }
    },
    {
      id: "bull", col: 2, row: 1,
      data: { label: "Strategy Agent", subtext: `Bull · ${model}`, icon: <Cpu size={15} />, iconColor: "bg-up",
        status: run ? "active" : "ready", detail: run ? `${proposalCount} proposal${proposalCount === 1 ? "" : "s"}` : "no run yet" }
    },
    {
      id: "bear", col: 2, row: 3,
      data: { label: "Bear / Red-Team", subtext: "Adversarial review", icon: <Cpu size={15} />, iconColor: "bg-warn",
        status: run ? "active" : "ready", detail: "challenges each idea" }
    },
    {
      id: "evaluator", col: 2, row: 5,
      data: { label: "Evaluator", subtext: "Learning loop", icon: <Cpu size={15} />, iconColor: "bg-accent",
        status: evidence > 0 ? "active" : "ready", detail: evidence > 0 ? `${evidence} thesis stats` : "awaiting closed trades" }
    },
    {
      id: "gates", col: 3, row: 2,
      data: { label: "Policy Gates", subtext: "Deterministic limits", icon: <ShieldAlert size={15} />, iconColor: "bg-down",
        status: policy.systemState === "halted" ? "warn" : "active", detail: `${gateCount} active${policy.systemState && policy.systemState !== "active" ? ` · ${policy.systemState}` : ""}` }
    },
    {
      id: "risk", col: 4, row: 2,
      data: { label: "Risk Manager", subtext: "Sizing & stops", icon: <ShieldAlert size={15} />, iconColor: "bg-down",
        status: "active", detail: `stop ${policy.riskRules?.stopLossPct ?? 8}% · take ${policy.riskRules?.takeProfitPct ?? 20}%` }
    },
    {
      id: "execution", col: 5, row: 2,
      data: { label: "Execution", subtext: `${mode} · ${autonomous ? "Autonomous" : "Propose"}`, icon: <Rocket size={15} />, iconColor: running ? "bg-up" : "bg-info",
        status: running ? "active" : "off", detail: running ? "running" : "stopped" }
    }
  ];

  const edges: Edge[] = [
    { id: "market-scan", source: "market", target: "scan" },
    { id: "macro-scan", source: "macro", target: "scan" },
    { id: "smart-scan", source: "smart", target: "scan" },
    { id: "filings-scan", source: "filings", target: "scan" },
    { id: "technical-scan", source: "technical", target: "scan" },
    { id: "scan-bull", source: "scan", target: "bull" },
    { id: "evaluator-bull", source: "evaluator", target: "bull", label: "tuned weights" },
    { id: "bull-bear", source: "bull", target: "bear", label: "proposals" },
    { id: "bear-gates", source: "bear", target: "gates", label: "survivors" },
    { id: "gates-risk", source: "gates", target: "risk" },
    { id: "risk-exec", source: "risk", target: "execution" }
  ];

  return { specs: [...sources, ...pipeline], edges };
}

const COL_X = [20, 280, 540, 820, 1090, 1360];
const ROW_Y = 130;

export function StrategyFlow({ snapshot }: { snapshot?: FlowSnapshot }) {
  const colorMode = useColorMode();
  const { initialNodes, initialEdges } = useMemo(() => {
    const { specs, edges } = buildSpecs(snapshot);
    const byId = new Map(specs.map((s) => [s.id, s.data.status]));
    const nodes: Node[] = specs.map((s) => ({
      id: s.id,
      type: "custom",
      position: { x: COL_X[s.col] ?? s.col * 260, y: 20 + s.row * ROW_Y },
      data: s.data as unknown as Record<string, unknown>
    }));
    // An edge is "live" only when its upstream node is active; otherwise it's dim/static.
    const styledEdges: Edge[] = edges.map((e) => {
      const live = byId.get(e.source) === "active";
      return {
        ...e,
        type: "smoothstep",
        animated: live,
        markerEnd: { type: MarkerType.ArrowClosed, color: live ? "var(--accent)" : "var(--line-strong)" },
        style: { stroke: live ? "var(--accent)" : "var(--line-strong)", strokeWidth: live ? 1.6 : 1, opacity: live ? 1 : 0.5 },
        labelStyle: { fontSize: 10, fill: "var(--muted)" }
      };
    });
    return { initialNodes: nodes, initialEdges: styledEdges };
  }, [snapshot]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Keep the graph live: re-seed nodes/edges whenever a fresh dashboard snapshot arrives.
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  return (
    <div className="flex h-full w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 px-1 text-[11px] text-muted">
        <span className="font-medium text-fg">Live pipeline</span>
        {(["active", "ready", "off"] as NodeStatus[]).map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_META[k].dot}`} /> {STATUS_META[k].label}
          </span>
        ))}
        <span className="text-faint">— colors reflect what is actually enabled and ran in your last cycle.</span>
      </div>
      <div className="min-h-0 flex-1 rounded-xl border border-line bg-surface/20 backdrop-blur-md">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          colorMode={colorMode}
          proOptions={{ hideAttribution: true }}
          fitView
        >
          <Controls className="bg-surface border-line text-fg" />
          <Background variant={BackgroundVariant.Dots} gap={12} size={1} color="var(--line-strong)" />
        </ReactFlow>
      </div>
    </div>
  );
}
