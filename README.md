# Thoughtloom

*Where ideas take shape.*

Thoughtloom explores a question: can AI help someone discover and develop thinking they would otherwise have missed?

Capture rough thoughts, find meaningful connections, and develop ideas through dialogue. Your original thinking stays intact as new ideas branch from it. Export the results as Markdown so they remain useful outside the application.

## Principles

- Preserve original thinking. Development adds new thoughts to a branching chain rather than rewriting the past.
- Keep titles editable, separate from immutable thought content and ancestry.
- Attribute AI contributions. Reading a suggestion does not mean agreeing with it.
- Give users control. Rejected material stays available for deliberate inspection but is excluded from the app's AI retrieval and context.

## Start here

**Using Thoughtloom?** Open your installation's web address and follow the [illustrated user guide](docs/user-guide.md). It covers everyday workflows, limitations and recovery when a request cannot be confirmed.

**Running your own installation?** Follow [Server startup](docs/server-startup.md), then [Production deployment](docs/production-deployment.md) for persistent services and access configuration. See [Backup and restore](docs/backup-restore.md) to protect your library and retained originals.

## What you can do today

- **Capture** a thought with an optional title. Change its title later without rewriting the original.
- **Find and browse** your thinking with keyword search, chronological lists and connected maps.
- **Connect ideas** yourself, or let background AI weaving suggest interpretations and relationships. **Reinterpret** requests a fresh interpretation without replacing earlier work.
- **Revisit thinking quietly** through configured daily review for missing titles and possible connections, without a separate review screen.
- **Develop ideas** through Evolve, keeping your contributions, AI developments and Full replies distinct.
- **Import Markdown, images and PDFs.** Markdown wording is preserved; image/PDF originals are retained separately from AI interpretations.
- **Ask your library** questions in saved search conversations that rediscover existing ideas without adding new thoughts.
- **Export Markdown**, either directly from an idea's development branches or as an AI-written report across your library.
- **Control AI use** by rejecting and restoring thoughts or connections. Add installation-wide agent guidance in Settings.

Capture, ordinary search, Browse, manual connections and Simple export work without a configured model. Markdown import can use structural grouping without AI; images and PDFs can be retained while interpretation waits. Background weaving stays queued until agents are configured. Evolve, new conversational-search turns and AI report generation require agent configuration by the operator.

AI output is a contribution to assess, not a verified conclusion. URL retrieval depends on available tools and source access; linked web pages are not archived. For image/PDF interpretation, Thoughtloom and its agent service must share access to retained originals. See the [user guide](docs/user-guide.md) for workflow details and [agent setup](docs/server-startup.md#agent-configuration) for configuration.

Weaver and Evolve can use tools provided by the operator. Those tools are not sandboxed by Thoughtloom's retrieval rules, and stopping a run cannot undo external changes. Operators should review the [tool-access policy](.lore/context/architecture.md#agent-tool-access-policy) before enabling them.

## Documentation

### Using and running Thoughtloom

| Document | What it covers |
| --- | --- |
| [User guide](docs/user-guide.md) | Start using Thoughtloom: capture, find, connect and develop ideas, import files, and export your thinking. Includes screenshots. |
| [Server startup](docs/server-startup.md) | Install and run Thoughtloom; configure agents and troubleshoot startup. |
| [Production deployment](docs/production-deployment.md) | Run persistent services; manage access, credentials, backups and upgrades. |
| [Backup and restore](docs/backup-restore.md) | Capture the library and original files, deliver backups through Git, and restore to an empty installation. |

### Developing Thoughtloom

Thoughtloom uses Bun and TypeScript, a Next.js/React web client, and a Hono daemon backed by SQLite. AI features attach to an operator-managed OpenCode service. Browser requests pass through the web server; credentials stay server-side.

| Document | What it covers |
| --- | --- |
| [Testing concepts](docs/testing.md) | Test commands, isolated fixtures, browser checks and manual walkthroughs. |
| [Daemon API](docs/daemon-api.md) | Authentication, routes, request/response shapes and examples. |
| [Database schema](docs/database-schema.md) | Persistence, relationships, constraints and migrations. |
| [Client design system](apps/web/DESIGN.md) | Implemented visual and interaction patterns. |
| [Product context](.lore/context/) | Product intent and working agreements; check implementation contracts for current behavior. |
| [Agent instructions](AGENTS.md) | Repository guidance for AI contributors. |
