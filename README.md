# KaneGrowth

Self-hosted household finance & life-ops platform — *building wealth from good habits at home.*

> **Status:** Early planning / initialization.

## Planned Architecture
- **Core:** Rust + Tauri v2 (Desktop, Android, iOS) with offline-first local SQLCipher/SQLite
- **Self-Hosted Server & Web UI:** Dockerized sync server + shared web frontend
- **Notifications:** `ntfy` integration for bills, budgets, and maintenance alerts
