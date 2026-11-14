---
title: MemFS | Letta Docs
description: Understand the git-backed memory filesystem used by Letta agents
applies_to:
  backends:
    - cloud
    - local
  interfaces:
    - web
    - desktop
    - cli
    - sdk
---

**MemFS** is how a Letta agent works with its long-term memory. The memory itself is part of the agent’s state, held in a git repository that belongs to the agent — hosted by Letta for cloud agents, alongside its conversations and configuration.

MemFS **projects** that repository onto whatever computer the agent is running on, as a real checkout the agent reads and edits with ordinary file tools. Edits are local until committed and pushed, at which point they become the agent’s memory everywhere. All Letta agents use MemFS.

MemFS is also called a [context repository](https://www.letta.com/blog/context-repositories).

Memory is addressed by path: the memory labelled `persona` is projected to `persona.md`. Choosing a label is choosing where the memory lives and whether it stays in context.

## Memory structure

Each memory except a `MEMORY.md` index is projected as Markdown with YAML frontmatter:

```
---
name: persona
description: "Who I am, what I value, and how I approach working with people."
---


I am a Letta agent. I remember durable preferences and improve with use.
```

Files at the memory root are loaded into the agent’s system prompt on every turn. Use them for the agent’s identity, important user preferences, durable project facts, and critical workflow rules. Older agents use a `system/` directory instead.

Directories with their own `MEMORY.md` index stay out of context until they are needed. The root `MEMORY.md` lists them, so directory and file names act as signposts the agent follows to read the right file. This keeps the active context lean while preserving deeper reference material.

```
$MEMORY_DIR/
├── MEMORY.md
├── persona.md
├── human.md
├── reference/
│   ├── MEMORY.md
│   └── project-notes.md
└── skills/
    └── my-skill/
        └── SKILL.md
```

## Semantic and vector search

MemFS does not include a semantic or vector index by default. Agents find memory in its Markdown files with normal file-search and read tools.

For keyword search and optional semantic or hybrid search, install the [MemFS Search mod](https://github.com/letta-ai/mods/tree/main/packages/memfs-search):

```
letta install npm:@letta-ai/memfs-search
```

Keyword search works without additional dependencies. Semantic and hybrid modes require [QMD](https://github.com/tobi/qmd) to be installed and indexed over `$MEMORY_DIR`.

Conversation-history search is separate from MemFS. On Letta Cloud, `letta messages search` supports full-text, vector, and hybrid search over messages; local backends currently search conversation transcripts with full-text matching only.

## Versioning and synchronization

Every memory edit is committed to the MemFS git repository. This provides version history, conflict resolution, and a clear boundary between saved memory and uncommitted changes.

For agents backed up to the cloud, commits push back to the hosted repository, so a projection on any other computer picks them up. Local-only agents commit to a repository on the current machine, so you are responsible for backing it up.

Memory subagents such as dreaming and memory doctor use git worktrees so they can update memory concurrently without blocking the main agent.

## Skills in MemFS

Agent-owned skills live under `$MEMORY_DIR/skills`. They are versioned with the rest of the agent’s memory and travel with agents that are backed up to the cloud.

See [Skills](/configuration/skills/index.md) for skill sources, precedence, and authoring.

## Shared memory

Each agent has its own MemFS. Use [shared memory](/concepts/shared-memory/index.md) when multiple cloud-hosted agents need access to the same Git-backed files and working context.

## Managing memory

See [Memory & dreaming](/configuration/memory/index.md) to initialize memory, teach your agent, configure background reflection, and reorganize a hierarchy that has grown over time.
