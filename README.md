# AI Bridge

AI Bridge is a personal Codex plugin that lets Codex plan and review while a confirmed local Claude Code iteration performs implementation work.

It assumes your `claude` CLI is already configured with the provider and model you want to use, including DeepSeek-compatible setups. AI Bridge does not manage credentials.

Run state is stored under `~/.ai-bridge/runs/<runId>/`; target repositories are inspected through git status and diff.
Each run stores a fixed `claudeSessionId`, and every Claude Code iteration for that run is invoked with `--session-id` so the Claude Code conversation remains continuous.
Async runs use Claude Code `stream-json` output. Raw events are archived as `iteration-<n>.stream.jsonl`, and Codex-facing summaries are archived as `iteration-<n>.transcript.jsonl` for live polling and review.
