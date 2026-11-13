# Smart Data Analysis and Visualization

Frontend and Supabase connection taken from the QueryPilot X project and simplified for this team project. Analysis, reporting, AI, and notification features are not included.

## Run

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Connection

Set `SESSION_SECRET` to a random value with at least 32 characters. Generate one with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

For Supabase OAuth, create an OAuth app in the Supabase organization, give it Projects: Read and Database: Read permissions, and use `http://localhost:3000/api/auth/callback` as the redirect URL. Add its client ID and secret to `.env.local`.

Alternatively, use a Supabase PostgreSQL connection string with a read-only database account. The browser sends it to the server once, and the server keeps it in an encrypted HttpOnly session cookie. The database connection is opened server-side only.

The PostgreSQL role should have access only to tables that the application is allowed to read. A possible setup is:

```sql
CREATE ROLE analysis_reader LOGIN PASSWORD 'use-a-strong-unique-password';
GRANT CONNECT ON DATABASE postgres TO analysis_reader;
GRANT USAGE ON SCHEMA public TO analysis_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO analysis_reader;
```

Use the correct Supabase pooler username format for the new role and project. Never use a superuser password or service role key for this connection.

The OAuth read-only database endpoint used in QueryPilot X is experimental and may be unavailable for some projects. The manual read-only connection is the fallback.

## Included

The landing page, connection screen, database details screen, Supabase OAuth, project selection, manual PostgreSQL connection, and encrypted browser sessions.
