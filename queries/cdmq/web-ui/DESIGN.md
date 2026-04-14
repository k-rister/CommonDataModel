# Crucible Web UI — Design and Implementation Guide

This document explains the design, architecture, data flow, and key implementation decisions of the Crucible Web UI. It is intended for developers (human or AI) who need to debug, maintain, or extend the codebase.

## Table of Contents

1. [Overview](#overview)
2. [Technology Stack](#technology-stack)
3. [Application Structure](#application-structure)
4. [Data Model](#data-model)
5. [Search Workflow](#search-workflow)
6. [Iteration Table](#iteration-table)
7. [Compare Workflow](#compare-workflow)
8. [Supplemental Metrics and Breakouts](#supplemental-metrics-and-breakouts)
9. [Autocomplete Dropdowns](#autocomplete-dropdowns)
10. [Theme System](#theme-system)
11. [URL State and Sharing](#url-state-and-sharing)
12. [Debug Console](#debug-console)
13. [Server API Endpoints](#server-api-endpoints)
14. [CDM Library Integration](#cdm-library-integration)
15. [Performance Considerations](#performance-considerations)
16. [Known Limitations and Future Work](#known-limitations-and-future-work)

---

## Overview

The Crucible Web UI is a React single-page application that enables performance engineers to:

1. **Search** for benchmark iterations across multiple runs using filters (benchmark, tags, params, user, date range)
2. **Compare** selected iterations visually with bar charts, grouping/series dimensions, and supplemental metric overlays
3. **Share** workflows via URL-encoded state

The UI communicates exclusively with the CDM API server (`server.js` on port 3000), which queries OpenSearch for all data. No direct OpenSearch access from the browser.

---

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Framework | React 19 + Vite | UI rendering, hot reload, build |
| Charting | Recharts 3.x | Bar/line/composed charts with tooltips and error bars |
| HTTP Client | Browser Fetch API | All API communication |
| Styling | Plain CSS with CSS variables | Theming (dark/light), responsive layout |
| API Server | Express (Node.js) | REST endpoints over OpenSearch/CDM |
| Data Store | OpenSearch | Persistent storage for CDM documents |

---

## Application Structure

```
web-ui/src/
  main.jsx              React entry point
  App.jsx               Root component: view routing, selection state, URL persistence
  index.css             All styles (theme variables, component styles)
  debugLog.js           Pub/sub logging store for API timing
  api/
    cdm.js              API client (fetch wrappers for all endpoints)
  components/
    SearchPanel.jsx     Search form with autocomplete filters
    IterationTable.jsx  Results table with sorting, grouping, clickable filters
    SelectionBar.jsx    Shows selected iteration count and chips
    CompareView.jsx     Bar charts with grouping, series, supplemental metrics
    AutocompleteInput.jsx  Reusable dropdown with single/multi-select
    DebugConsole.jsx    Collapsible timing/network log
```

### Component Hierarchy

```
App
  SearchPanel (ref: exposes addTagFilter, addParamFilter, setFiltersAndSearch, getFilters)
  SelectionBar
  IterationTable
  CompareView
  DebugConsole
```

### State Ownership

| State | Owner | Passed To |
|-------|-------|-----------|
| `iterations` (search results) | App | SearchPanel (as prop), IterationTable |
| `selected` (Map of iterationId -> iteration) | App | IterationTable, SelectionBar, CompareView |
| `view` (search/compare/deepdive) | App | Controls which view renders |
| `groupBy`, `seriesBy` | App | CompareView |
| `filters` (search form state) | SearchPanel | Internal; exposed via ref |
| `metricValues` (primary metric) | IterationTable | Internal (fetched on demand) |
| `supplementalMetrics` | CompareView | Internal |
| `theme` | App | CSS via `data-theme` attribute |

---

## Data Model

The CDM hierarchy is: **run > iteration > sample > period > metric**

### Iteration Object (Client-Side)

This is the core data structure passed around the UI. Each iteration object is assembled server-side by the `/iterations/details` endpoint:

```javascript
{
  runId: "uuid",                    // Parent run ID
  iterationId: "uuid",             // Unique iteration identifier
  benchmark: "uperf",              // Benchmark name
  tags: [{ name: "gro", val: "on" }],  // Run-level tags
  params: [{ arg: "wsize", val: "64" }, ...],  // All params for this iteration
  commonParams: [...],             // Params shared across all iterations in this run
  uniqueParams: [...],             // Params that vary within this run
  sampleCount: 3,                  // Number of samples (repetitions)
  passCount: 3,                    // Passing samples
  failCount: 0,                    // Failing samples
  primaryMetric: "uperf::Gbps",    // Primary metric name (source::type)
  runBegin: "1771369758322",       // Run start time (epoch ms, stored as string)
  runSource: "hostname//var/lib/crucible/run/...",  // Run source path
  runName: "\"Karl Rister\"",      // User name (may contain embedded quotes)
  runEmail: "krister@redhat.com"   // User email
}
```

**Important notes:**
- `commonParams` and `uniqueParams` are computed per-run by the server. The UI recomputes "globally unique" params/tags across all displayed iterations (see [Iteration Table](#iteration-table)).
- `runBegin` is an epoch-millisecond timestamp stored as a string in OpenSearch. The client parses it with `Number(ts)` before passing to `new Date()`.
- `runSource` format is `hostname//path`. The `//` separates hostname from the filesystem path. When building a URL, prepend `/` to the path portion after splitting on `//`.
- `runName` may contain embedded double quotes (a data quality issue). The CDM library's `mSearch` function builds term queries as JS objects (not string concatenation) to handle this.

### Metric Value Object

```javascript
{
  mean: 1234.56,           // Average across passing samples
  stddevPct: 2.3,          // Standard deviation as percentage of mean
  sampleValues: [1200, 1250, 1254]  // Individual sample values
}
```

### Supplemental Metric Object

```javascript
{
  source: "mpstat",
  type: "Busy-CPU",
  display: "panel" | "overlay",     // Panel = own chart; overlay = line on primary chart
  breakouts: ["direction"],          // Active breakout dimensions
  remainingBreakouts: ["hostname", "num", "type"],  // Available for further drilling
  loading: false,
  values: {
    "iterationId": {
      labels: {
        "<rx>": { mean: 5.2, stddevPct: 1.1, sampleValues: [5.1, 5.3] },
        "<tx>": { mean: 3.8, stddevPct: 0.8, sampleValues: [3.7, 3.9] }
      }
    }
  }
}
```

**Label encoding:** With no breakouts, the label is `""` (empty string). With breakouts, labels encode the breakout values: `"<rx>"`, `"<host1>-<cpu0>"`, etc. This is the format returned by `cdm.getMetricDataSets()`. The angle brackets are part of the label string.

---

## Search Workflow

### User Flow

1. User sets filters (benchmark, tags, params, date range, etc.)
2. Clicks Search (or presses Enter)
3. Server searches for matching run IDs, then batch-fetches iteration details
4. Results displayed in IterationTable
5. User can click unique param/tag badges to add as filters, then search again

### Implementation Details

**SearchPanel.jsx** manages the filter form state internally. It exposes methods via `useImperativeHandle` + `forwardRef`:

- `getFilters()` — returns current filter state
- `setFiltersAndSearch(filters)` — sets filters and triggers search (used for URL state restoration)
- `addTagFilter(name, val)` — adds a tag filter (appends to existing if same name)
- `addParamFilter(arg, val)` — adds a param filter (appends to existing if same arg)

**Search execution flow** (`handleSearch`):

1. Build `apiFilters` object from non-empty filter values
2. Call `api.searchRuns(apiFilters)` — server returns matching run IDs
3. Call `api.getIterationDetails(runIds, start, end)` — server returns hydrated iteration objects
4. **Client-side filtering**: params and primaryMetric are per-iteration, but the server only filters at the run level. The client filters iterations within the returned runs to match param/metric criteria.
5. Pass results to `onResults(iterations)` callback (App.jsx)

**Multi-value filter handling:**
- Tags and params support comma-separated values via the multi-select AutocompleteInput
- Server-side: OR within a field (union run IDs), AND across fields (intersect)
- Client-side: `fp.val.split(',')` then `vals.includes(String(p.val))`

**Date range scoping:**
- `buildYearDotMonthRange(instance, docType, start, end)` returns comma-separated index suffixes like `@2026.02,@2026.03`
- `getIndexName()` expands each suffix with the correct `baseName+docType` for any document type
- If no indices match the date range, returns `@<start>` (targets a non-existent index, returns empty results) instead of `@*` (which would query everything)

---

## Iteration Table

### Visual Design

The iteration table uses several visual techniques to reduce redundancy and guide users:

**Run grouping:**
- Iterations from the same run are grouped together with alternating background colors
- Run ID, date, and a "select all" checkbox occupy a single rowSpanned cell on the left
- A heavier border separates different run groups

**Common vs. Unique:**
- **Common section** (above the table): params/tags/benchmark that have the same value across ALL displayed iterations — shown once, not repeated per row
- **Unique column**: params/tags/benchmark that VARY across displayed iterations — each iteration row shows its own values
- This is computed globally across all iterations (not per-run like the server's `uniqueParams`)

**Clickable filters:**
- Unique param/tag badges in the table are clickable — clicking adds them as search filters
- This calls `SearchPanel.addTagFilter()` or `addParamFilter()` via the ref exposed by `useImperativeHandle`

**Primary metric values:**
- Not loaded with the initial search (too slow for many iterations)
- "Show Values" button triggers a separate API call (`/iterations/metric-values`)
- Values displayed inline: `uperf::Gbps 1234.56 (2.3%)`

### Param Filter

The text input at the top filters iterations by param name/value:
- Without `=`: searches both arg and val fields
- With `=`: splits on first `=`, matches arg on the left and val on the right
- Example: `wsize=64` matches iterations where any param's arg contains "wsize" AND val contains "64"

---

## Compare Workflow

### User Flow

1. Select iterations via checkboxes in the search view
2. Click "Compare (N)" button in the nav bar
3. Primary metric values auto-fetched
4. Bar chart displayed with one bar per iteration
5. Group-by auto-populated (sorted by distinct value count, fewest first)
6. Add supplemental metrics via "+ Add Metric"
7. Click a bar to pin it — shows values in sidebars, dims other bars

### Chart Architecture

The chart uses Recharts' `ComposedChart` which supports mixing Bar and Line components. The chart data is a flat array of entries, one per iteration, with gap entries inserted between groups.

**Chart data entry structure:**
```javascript
{
  name: "wsize=64",             // X-axis label (only remaining varying params/tags)
  value: 1234.56,               // Primary metric mean
  errorY: 23.4,                 // Stddev for error bars
  iterationId: "uuid",
  groupValue: "nthreads=1, protocol=tcp",  // Compound group key
  color: "#5b8def",             // Bar fill color
  isGap: false,                 // Gap entries for visual separation
  'supp_0': 0.42,              // Supplemental metric 0 value
  'supp_0_stddevPct': 1.5,
  'supp_0_error': 0.006,
  'supp_0_samples': 3,
  'supp_0_<rx>': 5.2,          // Breakout label values (when breakouts active)
  'supp_0_<tx>': 3.8,
}
```

### Label Hierarchy

The chart applies a hierarchical approach to reduce label redundancy:

1. **Chart subtitle**: Globally common params/tags/benchmark (same across all selected iterations)
2. **Hierarchical group headers**: Each group-by dimension gets its own row above the chart. Each row shows the dimension name on the left and value labels spanning the bars they cover, creating a pivot-table-like header.
3. **Bar labels** (X-axis): Only the remaining varying dimension(s) not used in group-by
4. **Bar value labels**: Metric values shown inside bars when they fit (checked against bar width and height). Hidden automatically when bars are too narrow.
5. **Value consolidation**: Params/tags with the same value are grouped in labels (e.g., `bs,rw,size=4k` instead of repeating `=4k` three times)

### Auto-Grouping

When entering the compare view, group-by dimensions are auto-populated:
1. `buildDimOptions()` scans iterations for varying dimensions only
2. Dimensions sorted by distinct value count (fewest first — best grouping levels)
3. All but the last dimension become group-by levels
4. The last dimension stays as the bar label
5. User can reorder chips with left/right arrow buttons
6. "Auto" button recomputes; "Clear" removes all

### Hide Fields

Users can hide specific params/tags from the compare view:
- Hidden fields excluded from group-by/series-by dropdowns, common/varying computation, and bar labels
- Shown as red strikethrough chips
- Hiding auto-removes from group-by if currently used

### Click-to-Pin and Selection Indicators

- **Click a bar** in the primary chart to pin its data in all sidebars
- **Red dashed ReferenceLine** appears at the selected bar's position in all chart panels
- **Non-selected bars dim to 20% opacity** across all panels
- Click the same bar again to unpin

### Grouping Implementation

1. `buildDimOptions()` scans iterations for varying dimensions only (>1 distinct value) — common dimensions are excluded from dropdowns
2. Multi-group-by: `groupByList` is an array of dimension strings, compound key computed by `getCompoundGroupValue()`
3. Iterations sorted by compound group key using `naturalCompare` (numeric-aware: 64 before 256 before 1024)
4. Per-group common items computed: params/tags that vary globally but are constant within a group
5. `buildIterLabel()` excludes all group-by dimensions and per-group common items from bar labels; consolidates params with same value
6. Gap entries (`{ isGap: true }`) inserted between groups for visual separation
7. Hierarchical headers rendered inside `compare-chart-area` with matching chart margins

### Y-Axis Management

- **Left Y-axis**: Primary metric (always present)
- **Right Y-axis**: Overlay-mode supplemental metrics (shown only when overlays exist)
- **Panel Y-axes**: Each panel-mode metric gets its own left Y-axis
- **Alignment**: Hidden right Y-axis (width=80 or width=1) added to all charts so bars align across panels
- **HTML labels**: Y-axis metric names rendered as HTML `<div>` elements outside the SVG to avoid Recharts clip-path issues
- **Tick formatting**: `formatYTick()` adapts precision based on magnitude (e.g., "1.2k", "0.423", "80")
- **Sidebar**: Each chart panel has a sidebar (300px) showing pinned iteration values

---

## Supplemental Metrics and Breakouts

### Adding a Metric

1. Click "+ Add Metric" — loads available metric sources from server
2. Select source (e.g., `mpstat`) — loads available types
3. Select type (e.g., `Busy-CPU`)
4. Choose display mode: **Overlay** (line on primary chart with right Y-axis) or **Own Panel** (separate bar chart)
5. Click "Add" — fetches metric values for all selected iterations

### Metric Control Panel

Each added metric is displayed as a row with:
- Colored left border (consistent color across chart and panel)
- Metric name (source::type) in monospace font
- Display mode badge ("overlay" or "panel")
- **+ Breakout** dropdown (populated with `remainingBreakouts` from server)
- **Chart type** selector (Bars, Stacked, Lines) — visible when breakouts are active
- **Sample** selector — choose which sample to display (auto-selects the sample closest to the primary metric mean)
- **Filter** input — accepts `gt:N`, `ge:N`, `lt:N`, `le:N` syntax for server-side label filtering
- Remove button (x)
- Active breakout chips with editable filter values

### Per-Sample Selection

Supplemental metrics query a single sample instead of averaging across all:
- Client computes the best sample index from `metricValues.sampleValues` (closest to mean)
- Server uses the provided `sampleIndex` directly
- Sample dropdown shows each sample's primary metric value for reference
- Filters work correctly since they operate on single-sample data

### Breakout Workflow

1. Click "+ Breakout" dropdown, select a dimension (e.g., "direction")
2. Client re-queries the metric with `breakout: ["direction"]`
3. Server returns multi-label values: `{ "<rx>": { mean, ... }, "<tx>": { mean, ... } }`
4. Server also returns updated `remainingBreakouts` for further drilling
5. Chart renders one bar/line per label; chart type selectable (Bars/Stacked/Lines)
6. User can add another breakout level (e.g., "hostname") — labels become `"<rx>-<host1>"`, etc.
7. Breakout chips have editable filter inputs accepting exact values, `val1+val2`, `r/regex/`, or `R/regex/`
8. "Apply" button re-queries with the filter applied
9. Removing a breakout re-queries with the reduced breakout array

### Data Format

Without breakouts:
```json
{ "labels": { "": { "mean": 5.2, "stddevPct": 1.1, "sampleValues": [5.1, 5.3] } } }
```

With breakout by "direction":
```json
{ "labels": { "<rx>": { "mean": 5.2, ... }, "<tx>": { "mean": 3.8, ... } } }
```

The empty string label `""` with no breakouts is correct — it means there's no additional dimension to encode. See the CDM metric label convention.

### Chart Rendering with Breakouts

**Panel mode:** Each label becomes its own `<Bar>` component with a distinct color. Chart type selectable:
- **Bars**: Side-by-side bars per breakout label
- **Stacked**: Bars stacked using Recharts `stackId`
- **Lines**: Line chart with dots per breakout label

**Overlay mode:** Each label becomes its own `<Line>` component on the right Y-axis.

**Supplemental panels render below the primary chart** so the primary chart with its X-axis labels appears first.

Label detection is done dynamically by scanning chart data entry keys for the pattern `supp_{index}_{label}` (excluding keys ending in `_stddevPct`, `_error`, `_samples`).

### Breakout Sidebar (Value Legend)

When a bar is clicked (pinned), each chart panel shows a sidebar with metric values:

- **No breakouts**: Simple label + value display
- **With breakouts**: Table layout with rowSpan for repeated segment values (like the iteration table's run grouping)
  - Column headers from breakout dimension names
  - Labels parsed into `<segment>` patterns and grouped hierarchically
  - Common text suffixes stripped and shown in header (e.g., `.local.net` removed from hostnames)
  - Common text prefixes stripped if no suffix found (e.g., `host-` removed)
  - Numeric-only columns skip deduplication
  - Delimiter-boundary detection (`.`, `-`, `_`, `/`) prevents splitting words

### Bar Value Labels

Metric values are displayed inside bars when they fit:
- `formatBarLabel()` produces compact values (3-4 significant digits, k/M suffixes)
- Custom `<LabelList>` content function checks `props.width` and `props.height` against text width estimate
- **Side-by-side bars**: shown if bar width > text width + 4px AND height > 16px
- **Stacked bars**: shown if segment height > 14px
- **Lines**: labels always skipped
- Font: 12px bold monospace, white with 90% opacity

---

## Autocomplete Dropdowns

`AutocompleteInput.jsx` is a custom replacement for native `<datalist>` that supports:

### Single Mode
- Text input with dropdown
- Typing filters options by substring
- Click or Enter selects a value

### Multi Mode (`multi` prop)
- Selected values shown as removable chips
- Input field for filtering
- Already-selected values hidden from dropdown
- Backspace in empty input removes last chip
- Dropdown stays open after selection for adding more

### Context-Aware Partitioning

Options are split into two groups based on `presentValues` (a Set):
1. **Present** (normal text): values that exist in current search results
2. **Absent** (grayed out): values from the API that don't appear in current results
3. A thin divider line separates the two groups

This is computed in `SearchPanel.jsx` via a `useMemo` that scans all iteration objects to build Sets of benchmark names, tag names/values, param args/values, etc.

### Lazy Loading

Options are fetched from the server on first focus via `loadOptions()`. A `ref`-based cache (`optionsCache`) prevents re-fetching. Tag/param value dropdowns refresh when their parent name/arg changes.

---

## Theme System

Two themes defined via CSS variables:
- `:root` / `[data-theme='light']`: Light background, dark text
- `[data-theme='dark']`: Dark background, light text (default)

Key variables: `--bg`, `--surface`, `--surface-alt`, `--border`, `--border-strong`, `--text`, `--text-secondary`, `--text-muted`, `--accent`, `--accent-light`, `--success`, `--danger`, `--warning`

Theme preference saved in `localStorage('theme')` and applied via `document.documentElement.setAttribute('data-theme', theme)`.

**Important:** SVG elements (Recharts) may not resolve CSS variables for `fill` and `stroke`. The Recharts Y-axis labels were moved to HTML `<div>` elements to avoid this issue. Tick colors using `fill: 'var(--text-secondary)'` work in most browsers but may need hardcoded fallbacks in edge cases.

---

## URL State and Sharing

The "Share" button encodes the current workflow state into the URL hash:

```
http://host:3000/#%7B%22benchmark%22%3A%22uperf%22%2C%22start%22%3A%222026.01%22%2C...%7D
```

### Encoded State

```javascript
{
  benchmark: "uperf",          // Search filters
  start: "2026.01",
  end: "2026.04",
  tags: [{ name: "gro", val: "on" }],
  params: [{ arg: "wsize", val: "64,256" }],
  selectedRuns: ["uuid1", "uuid2"],  // Run IDs (not iteration IDs — much shorter)
  view: "compare",
  groupBy: ["param:nthreads", "param:protocol"]  // Array of group-by dimensions
}
```

### Restoration Flow

1. On mount: `decodeState(window.location.hash)` parsed, stored in `restoredState.current`
2. `groupByList` set immediately (handles both array and legacy single-string format)
3. `view` NOT set yet (deferred until search completes)
4. After SearchPanel mounts: `setFiltersAndSearch(filters)` called via ref
5. SearchPanel updates filters, triggers search via `pendingSearch` ref + useEffect
6. `handleSearchResults` receives results, auto-selects iterations from matching run IDs
7. View switched to saved view (e.g., "compare")
8. `restoredState.current` cleared to prevent re-application on next search
9. If no groupByList was saved, auto-group runs on CompareView mount

**Key design decision:** View switch is deferred until after search + selection to avoid showing an empty Compare view while data is loading.

**Filters are saved in `lastFilters.current`** on every search result, because SearchPanel is unmounted when the user navigates to Compare view. The Share button uses `searchRef.current.getFilters() || lastFilters.current`.

---

## Debug Console

`DebugConsole.jsx` provides a collapsible panel at the bottom of the page showing:

- API calls with method, path, duration, status code
- Work items (client-side operations) with duration
- Info entries (search lifecycle markers)

**Implementation:** Uses `debugLog.js`, a simple pub/sub store:
- `addEntry(entry)` — creates a timestamped entry with a unique ID
- `updateEntry(id, updates)` — updates status, elapsed time, etc.
- `onChange(fn)` — registers a listener; returns unsubscribe function
- `timeWork(label, asyncFn)` — wraps an async operation with automatic timing

The API client (`api/cdm.js`) automatically logs every request via `addEntry` on start and `updateEntry` on completion.

---

## Server API Endpoints

The Express server (`server.js`) exposes the following endpoint categories:

### Run Discovery
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/runs` | Search runs by filters (name, email, benchmark, tags, params, date range) |

Supports comma-separated run IDs (OR) and comma-separated tag/param values (OR within field, AND across fields).

### Batch Iteration Fetching
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/iterations/details` | Hydrate iterations for multiple runs in one call |
| POST | `/api/v1/iterations/metric-values` | Fetch primary metric mean/stddev for iterations |

The `/iterations/details` endpoint accepts `{ runIds, start, end }` and returns fully assembled iteration objects. It uses `buildYearDotMonthRange` to scope queries, then sequentially calls:
1. `mgetBenchmarkName`, `mgetRunData`, `mgetIterations`, `mgetTags` (run-level)
2. `mgetParams`, `mgetSamples`, `mgetPrimaryMetric`, `mgetPrimaryPeriodName` (iteration-level)
3. `mgetSampleStatuses` (sample-level)
4. Computes common vs. unique params per run

### Supplemental Metrics
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/iterations/metric-sources` | Available metric sources across runs |
| POST | `/api/v1/iterations/metric-types` | Types for a given source |
| POST | `/api/v1/iterations/supplemental-metric` | Fetch metric values with optional breakouts |

The supplemental-metric endpoint accepts `{ iterations, runIds, start, end, source, type, breakout, filter, sampleIndex }`:
- `iterations`: array of `{iterationId, runId}` for targeted queries (avoids discovering all iterations from runIds)
- `sampleIndex`: which sample to query (client computes best sample from primary metric values)
- `breakout`: array of breakout dimensions with optional filters
- `filter`: value filter (gt:N, ge:N, lt:N, le:N)

Processing:
1. Uses provided iteration IDs directly (or discovers from runIds as fallback)
2. Gets primary period IDs and ranges
3. Builds metric data sets with the specified source, type, and breakouts
4. Calls `cdm.getMetricDataSets()` to fetch from OpenSearch
5. Aggregates per-label values across samples (mean, stddev)
6. Returns `{ values: { iterId: { labels: {...} } }, remainingBreakouts: [...] }`

### Field Values (for Dropdowns)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/fields/months` | Available YYYY.MM from index names |
| GET | `/api/v1/fields/run-ids` | Distinct run UUIDs |
| GET | `/api/v1/fields/names` | User names |
| GET | `/api/v1/fields/emails` | Emails |
| GET | `/api/v1/fields/benchmarks` | Benchmark names |
| GET | `/api/v1/fields/tag-names` | Tag names |
| GET | `/api/v1/fields/tag-values?name=X` | Tag values (optionally filtered by name) |
| GET | `/api/v1/fields/param-args` | Param arg names |
| GET | `/api/v1/fields/param-values?arg=X` | Param values (optionally filtered by arg) |
| GET | `/api/v1/fields/primary-metrics` | Primary metric names |

All field endpoints accept `?start=YYYY.MM&end=YYYY.MM` for date scoping.

### Per-Run Endpoints (Legacy, used by get-result-summary.js)
These endpoints use a `resolveRun` middleware that finds the OpenSearch instance and yearDotMonth for a run ID:
- GET `/api/v1/run/:id/tags`, `/benchmark`, `/iterations`, `/metric-sources`
- POST `/api/v1/run/:id/iterations/params`, `/primary-metric`, `/samples`, `/primary-period-name`
- POST `/api/v1/run/:id/samples/statuses`, `/primary-period-id`
- POST `/api/v1/run/:id/periods/range`, `/metric-types`
- POST `/api/v1/metric-data`

---

## CDM Library Integration

### Key cdm.js Functions Used by server.js

**Index Management:**
- `buildYearDotMonthRange(instance, docType, start, end)` — Returns comma-separated `@YYYY.MM` suffixes. The docType parameter is ignored (suffixes are docType-independent); `getIndexName` expands each suffix with the correct baseName+docType.
- `getIndexName(docType, instance, yearDotMonth)` — Splits comma-separated suffixes and expands each into a full index name.
- `checkCreateIndex(instance, index)` — Handles comma-separated index names by splitting and checking/creating each.

**Multi-Index Queries:**
- When yearDotMonth produces a multi-index name (containing commas), `esJsonArrRequest` puts the index in each NDJSON header line (`{"index": ["idx1", "idx2"]}`) instead of the URL path (OpenSearch rejects commas in URL path index names).
- Fetch concurrency scales down with multi-index queries: `batchSize = Math.floor(16 / numIndices)` to avoid overwhelming OpenSearch's search thread pool.

**Batch Query Functions:**
- `mgetBenchmarkName`, `mgetIterations`, `mgetTags`, `mgetRunData` — Run-level batched queries
- `mgetParams`, `mgetSamples`, `mgetPrimaryMetric`, `mgetPrimaryPeriodName` — Iteration-level
- `mgetSampleStatuses`, `mgetPrimaryPeriodId`, `mgetPeriodRange` — Sample/period-level
- `mgetMetricSources`, `mgetMetricTypes` — Metric discovery
- `getMetricDataSets` — Full metric data retrieval with breakout support

**Important:** `mgetPrimaryMetric` and `mgetPrimaryPeriodName` return 1D arrays (collapsed from 2D). Do NOT access `result[i][0]` — use `result[i]` directly. Accessing `[0]` on a string returns just the first character (e.g., "measurement"[0] = "m").

### mSearch Term Query Construction

The `mSearch` function builds term queries as JS objects (not string concatenation):
```javascript
var termObj = { term: {} };
termObj.term[termKeys[x]] = values[x][i];
req.query.bool.filter.push(termObj);
```
This correctly handles values with embedded special characters (e.g., user names with quotes).

---

## Performance Considerations

### OpenSearch Thread Pool

OpenSearch has a search thread pool with limited queue capacity (~1000). Multi-month queries across many runs can generate thousands of shard queries. Mitigations:

1. **Sequential mget calls:** The `/iterations/details` endpoint runs mget operations sequentially (not Promise.all) to avoid multiplying concurrent load
2. **Scaled fetch concurrency:** `batchSize = Math.floor(16 / numIndices)` reduces parallel HTTP requests for multi-index queries
3. **Graceful degradation:** `mSearch` returns empty arrays (not undefined) when individual sub-queries fail with 429 (thread pool exhaustion)
4. **Scoped queries:** Date range filtering limits which monthly indices are queried

### Metric Value Loading

Primary metric values are NOT loaded with iteration details (would add ~7 seconds for 177 iterations). Instead:
- "Show Values" button triggers a separate on-demand fetch
- Compare view auto-fetches only for selected iterations
- Supplemental metrics fetched individually per metric added

### Start-Server Restart Loop

`start-server.sh` runs server.js in a `while true` loop. Killing the Node process (`pkill -f 'node ./server.js'`) triggers an automatic restart with updated code after a 1-second delay. This avoids the need to stop/restart the container during development.

---

## Known Limitations and Future Work

### Current Limitations

- **Phase 3 (Deep Dive):** Time-series line charts are not yet implemented
- **Large result sets:** Searching across many months with hundreds of runs can be slow due to sequential OpenSearch queries
- **Bundle size:** Recharts adds ~400KB to the bundle. Code splitting could help.
- **Breakout label parsing:** CDM may omit breakout dimensions with single values from labels, making label-to-dimension mapping imperfect. The sidebar uses segment-based grouping to work around this.
- **Supplemental metric in URL state:** Currently supplemental metrics, breakouts, and hidden fields are not encoded in the Share URL

### Planned Features

- **Deep Dive view:** Time-series line charts with zoom/pan and interactive breakout exploration
- **Save/load workflows:** Server-side or localStorage persistence of named workflows
- **Supplemental metrics in URL state:** Encode added metrics, breakouts, and display modes in the Share URL
- **Drag-to-reorder:** Group-by chips currently use arrow buttons; drag-and-drop would be more intuitive
