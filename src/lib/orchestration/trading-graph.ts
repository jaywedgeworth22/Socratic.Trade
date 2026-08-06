import type { TradingPolicy, TradeProposal, ExecutionMode } from "../types";

export type GraphState = 
  | "INIT"
  | "DATA_GATHERING"
  | "ALTERNATIVE_DATA_ANALYSIS"
  | "FUNDAMENTAL_PROPOSING"
  | "RED_TEAM_REVIEW"
  | "EXECUTION"
  | "COMPLETED"
  | "FAILED";

export interface GraphContext {
  runId: string;
  policy: TradingPolicy;
  mode: ExecutionMode;
  userId: string;
  connectedAccountId: string;
  proposals: TradeProposal[];
  errors: Error[];
  // Extensible for future nodes
  metadata: Record<string, unknown>;
}

export interface GraphNode {
  name: GraphState;
  execute: (context: GraphContext) => Promise<{ nextState: GraphState; context: GraphContext }>;
}

export class TradingGraph {
  private nodes = new Map<GraphState, GraphNode>();
  private currentState: GraphState = "INIT";
  
  constructor(private context: GraphContext) {}

  public registerNode(node: GraphNode) {
    this.nodes.set(node.name, node);
  }

  public async run(): Promise<GraphContext> {
    while (this.currentState !== "COMPLETED" && this.currentState !== "FAILED") {
      const node = this.nodes.get(this.currentState);
      if (!node) {
        this.context.errors.push(new Error(`Node not found for state: ${this.currentState}`));
        this.currentState = "FAILED";
        break;
      }
      
      try {
        console.log(`[TradingGraph] Entering state: ${this.currentState}`);
        const result = await node.execute(this.context);
        this.currentState = result.nextState;
        this.context = result.context;
      } catch (error) {
        console.error(`[TradingGraph] Error in state ${this.currentState}:`, error);
        this.context.errors.push(error instanceof Error ? error : new Error(String(error)));
        this.currentState = "FAILED";
      }
    }
    
    return this.context;
  }
}
