# Phase 8 - Cockpit UI and Strategy Studio

This phase restructures the dashboard from a long vertical page into a
single-screen trading cockpit. The goal is to make the app usable during active
paper/live supervision without requiring page-level scrolling on a desktop
screen.

## Layout Model

- The desktop app shell uses `height: 100dvh` and three fixed rows: command bar,
  main cockpit, and bottom drawer.
- The main cockpit has three regions: left rail, center workspace, and right
  inspector.
- Page-level scrolling is intentionally disabled on desktop. Long content
  scrolls inside its pane.
- Mobile/tablet breakpoints revert to a single-column layout with normal page
  scrolling.

## User-Facing Tabs

- Center workspace tabs: `Decision`, `Market Scan`, `Performance`, `Strategy`.
- Right inspector tabs: `Operate`, `Risk`, `Profile`.
- Bottom drawer tabs: `Activity`, `Runs`, `Notifications`.

The `Decision` tab remains the default because the app's core value is showing
what the agent recommends or decided, not hiding that output in logs.

## Strategy Studio

Strategy Studio exists in two places:

- A center workspace `Strategy` tab for normal use.
- A command-bar modal for larger editing/review sessions.

It includes:

- editable strategy prompt with autosave
- reset-to-default prompt action
- slider/field controls for high-impact strategy and risk options
- scoring weight controls
- LLM strategy review button
- manual apply flow for suggested strategy/policy changes

LLM-generated strategy updates are advisory only. They do not mutate prompt,
policy, risk, or scoring weights until a human clicks `Apply Reviewed Changes`.
This is intentional: automatically rewriting the trading strategy without a
review gate is unsafe for an agentic trading tool.

## Strategy Tuning API

`POST /api/strategy/tune` gathers:

- active policy and prompt
- recent strategy runs
- recent fills in the active paper/live mode
- current performance summary
- latest market scan and proposal summary when available
- macro context from `src/lib/macro.ts`

When `OPENAI_API_KEY` is configured, the route asks the model for a strict JSON
strategy tuning proposal. Without the key, it returns a transparent local-rules
proposal so the UI path remains testable.

## Display Semantics

- Sentiment values are displayed as explicit chips: `Positive`, `Neutral`, or
  `Negative` with the numeric score.
- Up/down arrows are avoided for sentiment because they look like price
  direction or a buy/sell signal.
- Top status values are kept visible in the command bar: mode, portfolio,
  buying power, autonomy, daily risk, and allowed universe.

## Verification Expectations

After touching this phase, run:

```bash
npx tsc --noEmit
npm test
npm run build
```

For UI changes, also verify desktop and mobile behavior in a browser:

- desktop: body scroll height should equal viewport height
- mobile: shell overflow should become visible and page-level scrolling should
  return
