import { IconButton } from "socratic-trade-dashboard";
import { Settings, X, RefreshCw, Trash2 } from "lucide-react";

export const Common = () => (
  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
    <IconButton label="Settings">
      <Settings size={16} />
    </IconButton>
    <IconButton label="Refresh quote">
      <RefreshCw size={16} />
    </IconButton>
    <IconButton label="Close panel">
      <X size={16} />
    </IconButton>
    <IconButton label="Remove from watchlist">
      <Trash2 size={16} />
    </IconButton>
  </div>
);

export const Disabled = () => (
  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
    <IconButton label="Refresh quote" disabled>
      <RefreshCw size={16} />
    </IconButton>
    <IconButton label="Close panel" disabled>
      <X size={16} />
    </IconButton>
  </div>
);

export const InContext = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      width: 320,
      padding: "10px 14px",
      borderRadius: 12,
      border: "1px solid var(--line)",
      background: "var(--surface)"
    }}
  >
    <div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>NVDA position</div>
      <div style={{ fontSize: 12, color: "var(--faint)" }}>142 shares @ $118.42</div>
    </div>
    <div style={{ display: "flex", gap: 8 }}>
      <IconButton label="Refresh quote">
        <RefreshCw size={16} />
      </IconButton>
      <IconButton label="Remove from watchlist">
        <Trash2 size={16} />
      </IconButton>
    </div>
  </div>
);
