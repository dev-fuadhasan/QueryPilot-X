# QueryPilot AI Intelligence Studio

This module introduces two independent but connected capabilities in the **Smart Data Analysis & Visualization** section.

## 1. Autonomous Investigation Engine
In the Smart Data Analysis workspace, the **AI Studio** tab opens by default. Choose a connected public-schema table, optionally edit the investigation goal, and select **Start investigation**.

The client executes five sequential, visible stages through POST /api/smart-investigation:

1. **Plan:** inspect the authorized table schema, identify valid numeric metrics, categorical dimensions and date columns. When GROQ_API_KEY is configured, the model suggests a plan using *only* approved field names. A schema-guided fallback works without the model.
2. **Profile:** calculate missing-value percentages for the selected fields using at most 5,000 sampled records.
3. **Overview:** calculate live record counts and (if a numeric metric is present) total, mean, minimum and maximum.
4. **Drivers:** compute ranked category aggregates where a suitable dimension exists.
5. **Trend:** calculate the last 24 observed monthly aggregates where a real date/timestamp field exists.

The result panel shows factual, computed observations and each stage's read-only SQL query. Stages with unsupported schema requirements are marked *Not applicable* rather than inventing results. Individual failed stages do not erase successfully computed evidence.

## 2. Interactive Dashboard Builder
Switch to **Dashboard builder** or use **Turn findings into an interactive dashboard** after an investigation. If nothing has been investigated, click **Generate dashboard** to execute the investigation pipeline first.

- KPI cards are created from real aggregated values.
- Trend, category ranking, and category-share panels appear only when the source supports them.
- Click a chart segment or filter pill to recalculate *all linked KPI and chart aggregates* through read-only database queries.
- Add or remove cards, rename panels, toggle card width, and drag cards into a new order; keyboard-accessible arrow controls are also provided.
- Save the dashboard's title and layout in the current browser, scoped by Supabase project and table. **Data rows are not persisted in browser storage.**
- Print the dashboard or save it as PDF using the browser's print dialog.
- Return to **Ask AI** for the original conversational SQL analysis experience.

## Security and limitations

- Requires the existing Supabase OAuth or authenticated PostgreSQL session. The API validates origin, session, table membership, and field names.
- Queries are read-only aggregation statements; arbitrary SQL from the model is never executed by this engine.
- Personal/contact-like column names and identifier-like fields are excluded from suggested metrics and dimensions.
- Profiling uses a bounded, non-random sample of up to 5,000 records. Its missingness rates are sample statistics, not guaranteed whole-table estimates.
- Category panels show the top 12 results. Temporal panels show at most 24 months. These are not complete historical reports for larger data.
- Categories longer than 110 characters are grouped under their first 110 characters.
- The pipeline works with one selected table at a time and does not assume relationships between tables.
- The investigation reports descriptive associations and changes, not causal explanations or validated forecasts.
- The dashboard's layout is stored locally, so another browser or device will not inherit the user's saved card layout.

## Suggested capstone demonstration

1. Log in with Supabase and select a project with at least one readable public table.
2. Open **Smart data analysis** > **AI Studio**.
3. Choose a table, enter a goal, and start the investigation.
4. Watch the stages execute; expand the SQL evidence and review the missingness profile.
5. Convert the findings into a dashboard.
6. Click a category to filter all KPIs and charts. Show the recalculation.
7. Drag, resize, and rename a card; save the layout.
8. Open **Ask AI** to show that the earlier chatbot analysis still works.

The module uses the existing Next.js, React, Recharts, Groq (optional), and Supabase stack. No new package dependencies or database migrations are required.
