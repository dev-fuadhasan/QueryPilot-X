# QueryPilot Smart Data Analysis — Dashboard Builder

The **Smart Data Analysis** module now uses one unified workspace with **Dashboard**, **Ask AI**, and **Datasets**. The standalone Investigation tab and findings screen have been removed.

## Dashboard generation
- Opening the Dashboard automatically launches a five-stage, visible workflow: schema planning, bounded row-quality profiling, metric aggregation, category breakdown, and temporal analysis when supported.
- Once the stages finish, the progress view is replaced with the interactive dashboard.
- Rebuild refreshes the dashboard; the optional Analysis focus adjusts the verified-column plan.
- Data is queried through the existing authorized Supabase session. The AI may suggest verified column names but cannot execute arbitrary SQL.
- Unsupported stages are skipped or reported without fabricated figures.

## Dashboard controls
- Existing cards include KPI totals, time trends, category charts, and supporting data where valid.
- Selecting a group updates linked default cards through authorized read-only aggregate queries.
- Cards can be renamed, resized, dragged, reordered with arrow controls, or removed.
- Save layout stores the layout only in browser localStorage, scoped to the Supabase project and table.
- Print / PDF uses the browser print dialog.

## User-described panels
The **Create your own panel** form accepts:
- A short description of the requested calculation and visual, for example **"Average price by category"**, **"Monthly order count"**, **"Revenue by region"**, **"Total orders"**, or **"Category share pie chart"**.
- An optional custom title.

The server uses an AI-assisted or schema-validated deterministic interpretation of the description, verifies available numeric, text, and date columns, then performs read-only aggregation. Results are rendered as a verified KPI, bar, line, area, pie, or table panel.

If required fields are absent, the requested calculation isn't supported, or the database returns no matching records, the form displays a floating notification explaining why the panel could not be created. **No placeholder or random panel is added.**

Custom panels refresh against the database whenever the linked dashboard filter changes. Stored layouts contain only the selected panel specification; data values are requested again when the panel is opened. Filter-click linking is enabled only when a custom panel groups by the same column as the dashboard-wide category filter.

The custom builder **does not** claim forecasting, causality, correlation, arbitrary joins, or other unsupported statistical calculations.

## Shared UI
- **Dashboard** maintains the full workspace and background.
- **Ask AI** opens a matching overlay drawer while preserving the dashboard underneath. The original chat workflow, supporting tables, chart previews, SQL evidence, and exports remain available inside the drawer.
- **Datasets** uses the same navigation and design. Its original table-selection and schema details remain available.

## Security and bounds
- All new routes check the same-origin request and authenticated Supabase session, verify the selected public table and approved column names, and build SQL from server-owned templates.
- Data-quality profiling uses at most 5,000 rows; grouped charts show a limited ranked selection; time trends show up to 24 months.
- Computed analyses are descriptive. They do not prove causal relationships.
- Access remains subject to the connected Supabase account's permissions.

## Demonstration
Connect to Supabase, select a table, open **Dashboard**, watch the progress stages, and inspect the generated dashboard. Enter **"Average price by category"** in **Create your own panel**, show the new card, then try a request the dataset cannot satisfy to demonstrate the rejection notification. Open **Ask AI** and **Datasets** to show that they share the same redesigned workspace.


## Palette and exact result counts

The connected workspace header, its three feature buttons, the Dashboard Builder filter bar,
Performance snapshot cards, and highlighted Dataset Explorer surfaces use the primary
palette navy `#131B2B` and slate `#2F4A63` with white text. Other panels remain light
for chart and tabular-data readability. Interactive states use blue `#5B91A3`.

The custom-panel API enforces requested quantities on the server, not just in charts:
- "top five products" ranks products by record count and returns up to five groups;
- "top 5 products by revenue" aggregates revenue and returns up to five groups;
- "bottom three categories" uses ascending rank;
- "latest six months" returns up to six observed monthly periods.

The exact validated `resultLimit` and `sortDirection` are stored with each custom
panel definition and applied again when it refreshes. If the table contains fewer
eligible groups than requested, only those available are shown. Requested quantities
must be from 1 to 30; larger requests receive an explicit validation error instead
of silently showing an unrelated number of categories. By default, group results
show at most 12 categories and time-series panels at most 24 periods.

The bar chart renders every returned category; larger charts have a vertically
scrollable container. The UI does not silently truncate a requested top-N result.

Ranking parser tests can be run with:
`npx tsx --test smart_data_analysis_and_visualization/tests/panelRanking.test.ts`
