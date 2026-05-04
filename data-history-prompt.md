# PLC-Sheets — Data Historian Feature Prompt

## Context

PLC-Sheets is an Electron + Node.js application that acts as a spreadsheet editor (opening `.xls`/`.xlsx`/`.xlsm`/`.csv` files) with inline Modbus TCP communication via custom `MODBUS_READ_*` / `MODBUS_WRITE_*` formula functions.  See `outline.md` for the full application spec.

## Feature Request

Add a **data historian** with a **trend viewer** to the application.  The historian continuously records sampled values from Modbus tags (cells containing `MODBUS_READ_REGISTER` or `MODBUS_READ_COIL` formulas) to a local time-series store and the trend viewer lets the user plot historical values over a selected time window.

---

## Storage — LevelDB

Use **`classic-level`** (the current maintained Node.js LevelDB binding) as the historian storage engine.

### Key format

Fixed-width big-endian binary keys so lexicographic order equals chronological order:

```
[ 4 bytes: tagIndex uint32 BE ][ 8 bytes: timestamp uint64 BE (Unix ms) ]
```

A tag index registry maps tag identifiers (e.g. `"I:40001"` or a cell address) to stable uint32 IDs and is persisted separately (JSON sidecar or a reserved LevelDB key prefix).

### Range queries

```js
db.createReadStream({
  gte: encodeKey(tagIndex, startTs),
  lte: encodeKey(tagIndex, endTs)
})
```

#### Start-boundary look-back

Because on-change storage may have no record inside the query window, always prepend the last recorded value **before** the window:

```js
const iter = db.iterator({ lt: encodeKey(tagIndex, startTs), reverse: true, limit: 1 });
const [, initialValue] = await iter.next();
// prepend { ts: startTs, value: initialValue } to the result set
```

### On-change / exception reporting

Do **not** write every sample — only write when the value has changed meaningfully or the heartbeat fires:

```
if |newValue − lastStoredValue| > deadband  OR  (now − lastWriteTs) > heartbeatInterval:
    write(key, value)
    lastStoredValue = newValue
    lastWriteTs = now
```

- **Deadband** — configurable per-tag (default: `0`, i.e. any change triggers a write). Useful for analog registers.
- **Heartbeat interval** — configurable globally and per-tag (default: `60 s`). Forces a write even when the value is stable so the historian can distinguish "stable" from "offline".

### Write batching

Accumulate samples in a memory ring buffer and flush with `db.batch()` every **1 second** (configurable) rather than writing one record at a time.

### Retention

A background timer (runs every hour) deletes keys older than a configurable retention window (default: **30 days**) using a prefix scan per tag.

### Target write rates (design envelope)

| Scenario | Rate | Tags |
|---|---|---|
| Normal | 1 s | 100 |
| Fast | 250 ms | 100 |
| Wide | 1–2 s | 1 000 |

---

## Storage file layout

```
<workbook-dir>/
  myfile.xlsx
  myfile.xlsx.history/        ← LevelDB directory (created on first historian write)
    CURRENT
    MANIFEST-…
    …
```

The historian directory is associated with the workbook by filename convention.  If it does not exist, the trend viewer shows an empty state rather than an error.

---

## Historian Formula — `HISTORY_CAPTURE`

Historization is configured cell-by-cell via a pseudo-formula, consistent with the `MODBUS_*` and `UI_BUTTON_*` patterns in the rest of the app.

```
=HISTORY_CAPTURE(tag, value [, deadband [, heartbeat_seconds]])
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `tag` | string | Yes | Arbitrary historian tag name (alphanumeric, hyphen, underscore — same rules as server names). Registered in the tag index on first evaluation. |
| `value` | cell ref or expression | Yes | The value to historize. Typically a reference to a cell containing a `MODBUS_READ_*` formula. |
| `deadband` | number | No | Per-formula override for the on-change deadband. Defaults to the global historian setting (`0`). |
| `heartbeat_seconds` | number | No | Per-formula override for the heartbeat interval. Defaults to the global historian setting (`60`). |

**Timestamp:** Do **not** use `Date.now()` at formula evaluation time. The timestamp recorded for each sample must be the poll timestamp attached to the upstream `MODBUS_READ_*` result — i.e. the moment the main process received the raw bytes from the device. This timestamp travels with the cell value through the poll engine → formula evaluator → historian pipeline. If no upstream Modbus timestamp is available (e.g. the value source is a plain cell), fall back to the time the value change was detected in the formula engine.

**Displayed value:** The cell renders a short status string rather than the recorded value. Examples:

| State | Display |
|---|---|
| Recording normally | `OK  2026-05-04 14:32:01` |
| Deadband suppressed (no write) | `SKIP (deadband)` |
| Historian DB not open | `ERR: historian not open` |
| Tag name conflict (same name, different cell) | `ERR: tag conflict` |

The cell is **not volatile** — it does not force a recalc on every tick. It updates only when its `value` argument changes or a status transition occurs.

**Formula bar autocomplete** should include `HISTORY_CAPTURE` in the same autocomplete list as the `MODBUS_*` functions, with a parameter hint.

---

## Downsampling for display

Run **LTTB (Largest-Triangle-Three-Buckets)** in the main process before sending data to the renderer via the context bridge.  Target ~2 000 output points regardless of query window size.  The `downsample` npm package provides this algorithm.

---

## Trend Viewer UI

- Opens in a **separate `BrowserWindow`** (non-blocking, user can reposition).
- Library: **uPlot** (canvas-based, purpose-built for dense process-data time series, ~40 KB, MIT).
- Controls:
  - Tag selector (multi-select from known tag list)
  - Time range picker (preset buttons: Last 1 h / 6 h / 24 h / 7 d, plus a custom from/to)
  - Y-axis auto-scale or fixed range per tag
  - A "Live" toggle that re-queries every poll interval and appends new points without a full redraw

---

## IPC surface (main ↔ renderer)

| Channel | Direction | Payload |
|---|---|---|
| `history:query` | renderer → main | `{ tag, startTs, endTs, maxPoints }` |
| `history:queryResult` | main → renderer | `{ tag, points: [{ts, value}[]] }` |
| `history:tagList` | renderer → main | `{}` |
| `history:tagListResult` | main → renderer | `{ tags: [{id, label, unit}[]] }` |

---

## Out of scope for this feature

- Back-compat storage inside the `.xlsx` file itself (trend *configuration* may be stored as a custom XML part in a future iteration, but raw history data stays in LevelDB).
- Any external server process (InfluxDB, TimescaleDB, etc.).
- Macros or external workbook references (per main app spec).

---

## User Documentation

Generate end-user documentation covering the sections below.  Write in plain language suitable for a controls engineer or technician who is familiar with Excel formulas and PLCs but is not a software developer.  Avoid implementation details (no mention of LevelDB, LTTB, IPC, etc.).

### Section 1 — Overview

Briefly explain what the historian does: it silently records the value of any cell tagged with `HISTORY_CAPTURE` over time, storing the history locally alongside the workbook file.  Explain that a separate Trend Viewer window lets the user plot that history.  Mention that no external server or database software is required.

### Section 2 — Setting Up a Historian Tag with `HISTORY_CAPTURE`

Explain that historization is opt-in and configured directly in the spreadsheet by placing a `HISTORY_CAPTURE` formula in any cell.

#### 2.1 Syntax

Show the full formula signature and a realistic example:

```
=HISTORY_CAPTURE(tag, value [, deadband [, heartbeat_seconds]])
```

Example:
```
=HISTORY_CAPTURE("PumpSpeed", B4)
=HISTORY_CAPTURE("PumpSpeed", B4, 0.5, 30)
```

#### 2.2 Arguments

Cover each argument in plain terms:

**`tag`** (required)
A short name you choose for this data point — it is what appears in the Trend Viewer's tag list.  Use letters, numbers, hyphens, and underscores; no spaces.  The same tag name must not be used in more than one cell (the cell will show an error if it is).

**`value`** (required)
The cell or expression whose value you want to record.  This is almost always a reference to a cell containing a `MODBUS_READ_REGISTER` or `MODBUS_READ_COIL` formula.  The historian uses the exact timestamp from the Modbus poll — the moment the PLC responded — not the time the spreadsheet recalculated, so the history is as accurate as the underlying poll.

**`deadband`** (optional, default `0`)
Explain deadband with an analogy: imagine a thermostat that only clicks on when the temperature drifts more than 1 °F from the setpoint — it avoids chattering on tiny noise.  Deadband works the same way for the historian.  When the new value differs from the last *recorded* value by less than the deadband, the sample is silently skipped and the cell shows `SKIP (deadband)`.  When the change exceeds the deadband, the new value is recorded immediately.

- A deadband of `0` (the default) records every change, no matter how small.
- For a noisy analog sensor fluctuating ±0.2 units around a stable reading, setting `deadband` to `0.3` prevents hundreds of nearly-identical records from accumulating.
- For a coil or integer status tag, leave deadband at `0` — any bit flip should be captured.

**`heartbeat_seconds`** (optional, default from global setting, typically `60`)
Even if the value never crosses the deadband, the historian still writes one record every `heartbeat_seconds`.  This serves two purposes:
1. **Proves the tag is alive** — a gap longer than the heartbeat interval in the trend means the application was closed or the tag was removed, not that the value was just stable.
2. **Anchors the left edge of a query** — when you zoom in to a time window where the value didn't change, the historian can still plot a flat line from the last known value.

Lower values use slightly more storage but make the "last seen alive" time more precise.  Values shorter than the poll rate have no additional benefit.

#### 2.3 What the cell displays

The cell does not show the historized value — it shows the current recording status.  Explain each status string the user may see:

| Display | Meaning |
|---|---|
| `OK  2026-05-04 14:32:01` | Recording normally; timestamp is the last time a value was written to history. |
| `SKIP (deadband)` | The last sample was within the deadband of the previously recorded value — no write occurred.  This is normal for stable signals. |
| `ERR: historian not open` | The history database has not been opened yet (the workbook may still be loading) or could not be opened (check that the folder alongside the workbook is not read-only). |
| `ERR: tag conflict` | The same tag name is already used in another cell.  Rename one of them. |

### Section 3 — Global Historian Settings

Explain that global defaults for deadband, heartbeat interval, batch flush interval, and data retention are configured in the application's Settings panel (same place as Modbus interface settings).  Per-formula arguments override the global defaults for that specific tag only.

Describe each global setting:

- **Default deadband** — Applied to any `HISTORY_CAPTURE` formula that does not supply its own `deadband` argument.
- **Default heartbeat interval** — Applied to any formula that does not supply `heartbeat_seconds`.
- **Batch flush interval** — How often (in seconds) buffered samples are written to disk in one go.  Lower values mean less data is lost if the application crashes unexpectedly, at a small cost to disk activity.  Default: `1 s`.
- **Retention period** — How many days of history to keep.  Older records are automatically deleted in the background once per hour.  Default: `30 days`.  Increase for longer trend reviews; decrease to save disk space.

### Section 4 — Viewing Trends

Explain how to open the Trend Viewer (toolbar button or menu item) and describe each control:

- **Tag selector** — Check one or more tags to plot.  Each tag gets its own y-axis color.  Tags with no recorded data in the selected window are listed but plot as empty.
- **Time range presets** — Buttons for Last 1 h / 6 h / 24 h / 7 d jump to that window immediately relative to now.
- **Custom range** — Enter an explicit start and end date/time for historical review.
- **Y-axis scaling** — "Auto" fits the visible data; "Fixed" lets you enter a min/max so the axis doesn't rescale as data streams in.
- **Live toggle** — When enabled, the trend advances in real time, adding new samples as they are recorded.  Disable it to freeze the view for analysis.

### Section 5 — Storage and File Management

Explain where the data lives in plain terms:

When you open (or save) a workbook named `myfile.xlsx`, a folder called `myfile.xlsx.history` is automatically created in the same directory.  This folder contains the historian database.  It is safe to copy or back up this folder alongside the workbook — trend history will be available on any machine that has PLC-Sheets installed.  Deleting the folder permanently erases all recorded history for that workbook.

Mention that the history folder is not part of the `.xlsx` file itself and will not open in Excel.

### Section 6 — Tips and Common Patterns

- **Reference the Modbus cell directly** — `=HISTORY_CAPTURE("Tag1", B4)` where `B4` contains `=MODBUS_READ_REGISTER(40001)` is the preferred pattern.  The historian will receive the poll timestamp from the Modbus read.
- **Use meaningful tag names** — Tag names appear in the Trend Viewer list and cannot be changed without also editing the formula.  Treat them like instrument tag names on a P&ID.
- **Deadband for analog, none for discrete** — Analog sensors (temperature, pressure, flow) benefit from a small deadband to filter noise.  Boolean or integer status registers should use `0` so no change is missed.
- **Don't historize calculated cells unnecessarily** — Historizing a cell that is the sum of two Modbus registers is fine, but it doubles the storage versus historizing the source registers individually.  Historize at the point closest to the source.
