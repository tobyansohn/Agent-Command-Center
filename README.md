# Agent Command Center

An RPG-themed desktop command center where Claude agents live in a pixel-art world. Each agent is a specialist with its own room, personality, and Pokémon identity. Talk to Claude (the Oracle) in the main chat — she collaborates with specialist agents behind the scenes — or open any agent's sidebar card to chat with them directly.

## Agents

| Agent | Pokémon | Role |
|---|---|---|
| 🔮 Claude (Oracle) | Alakazam | Orchestrator & general-purpose assistant |
| 📚 Aria (Scholar) | Noctowl | Research, summarization, analysis |
| ⚒️ Forge (Blacksmith) | Heatran | Code, debugging, engineering |
| 🗺️ Vex (Strategist) | Zoroark | Planning, task breakdown |
| 📬 Swift (Herald) | Pidgeot | Writing, emails, documents |
| 📜 Hermes (Historian) | Metagross | Memory keeper — maintains the Library |

## How collaboration works

- **Oracle** receives every general-chat message and decides whether to answer directly or consult specialists.
- **Specialists** can ask Oracle clarifying questions mid-task via an `ask_oracle` tool.
- **Hermes** auto-logs significant interactions to a markdown Library (`library/raw/`, `library/wiki/`, `library/output/`) compatible with Obsidian.
- Every agent has read-only access to the Library; only Hermes writes.

## Setup

```bash
npm install
cp .env.example .env
# Add your Anthropic API key to .env
npm start
```

## Stack

- Electron (frameless desktop window)
- `@anthropic-ai/sdk` with `claude-sonnet-4-6`
- Pixel-art sprites from [Pixel Lab](https://pixellab.ai)
- Tool-use orchestration with parallel specialist consultations
