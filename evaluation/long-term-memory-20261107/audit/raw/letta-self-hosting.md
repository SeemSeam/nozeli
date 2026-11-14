---
title: Self-hosting | Letta Docs
description: Store agents locally or on infrastructure you control
applies_to:
  backends:
    - local
  interfaces:
    - cli
    - sdk
---

Letta agents can run entirely on infrastructure you control, in two shapes:

- **Local runtime**: The CLI runs agents in-process. All agent state, including messages, memory, and provider connections, stays on-device, and no Letta account is required.
- **Self-hosted App Server**: Run the Letta App Server to host local agents on a central, always-on machine and expose them to client applications through the [Agent SDK](/agent-sdk/index.md). Run messaging channels in a separate server process on the same machine.

**Limitations of self-hosting:** Built-in tools run where the agent harness runs: on the local machine for the CLI, or on the machine running App Server. When you connect through the Agent SDK, [client tools and MCP tools](/agent-sdk/mcp/index.md) can instead run through the SDK host or a configured MCP server. Self-hosted agents cannot be accessed through chat.letta.com and are not automatically backed up. Back up their state manually if you need to preserve or move it.

If your agents live in Letta Cloud and only need a persistent machine for files and tools, [deploy a computer](/platform/computers/byom/index.md) instead. The computer appears in Letta’s computer picker while agent state remains in Letta Cloud.

## Setup

- [App Server](#tab-panel-10)
- [CLI](#tab-panel-11)

1. **Install the Letta CLI**

   Run the following command to install the Letta CLI via your terminal (requires [Node.js](https://nodejs.org/en/download) version 22.19+):

   ```
   npm install -g @letta-ai/letta-code
   ```

2. **Connect model providers**

   Connect the model providers you want your agents to use, for example a locally running Ollama server:

   ```
   letta --backend local connect ollama
   ```

   You can also connect external API keys or other local inference servers:

   ```
   letta --backend local connect anthropic --api-key "$ANTHROPIC_API_KEY"
   letta --backend local connect lmstudio --base-url http://127.0.0.1:1234/v1
   ```

   See [Models](/configuration/models/index.md) for the full list of supported providers.

3. **Run the Letta server**

   Start the [App Server](/self-hosting/app-server/index.md) with the local backend:

   ```
   letta server --backend local --listen ws://127.0.0.1:4500
   ```

   The process prints the base URL and channel URLs at startup. See the [App Server quickstart](/self-hosting/app-server/quickstart/index.md) for authentication and configuration options.

4. **Add channels (optional)**

   To make your agents reachable through messaging platforms, start a separate local server process with one or more [channels](/self-hosting/channels/index.md):

   ```
   letta server --backend local --channels slack
   ```

   See the channel-specific guides for setup instructions, e.g. [Slack](/self-hosting/channels/slack/index.md), [Telegram](/self-hosting/channels/telegram/index.md), or [Discord](/self-hosting/channels/discord/index.md).

5. **Connect via the SDK (optional)**

   Connect to the running server from your application with the [Letta Agent SDK](/agent-sdk/index.md)’s remote backend:

   ```
   import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";


   const client = new LettaAgentClient({
     backend: "remote",
     url: "http://127.0.0.1:4500",
   });
   ```

   See the [Agent SDK](#agent-sdk) section below for a full example.

1) **Install the Letta CLI**

   Run the following command to install the Letta CLI via your terminal (requires [Node.js](https://nodejs.org/en/download) version 22.19+):

   ```
   npm install -g @letta-ai/letta-code
   ```

   To launch the Letta CLI, run:

   ```
   letta
   ```

   If you’re running the Letta CLI interactively for the first time, a Tutor agent will be auto-created for you.

2) **Connect to LLM providers**

   Use `/connect` to connect external API keys, coding plans, and local inference servers.

3) **Navigate to your project**

   ```
   cd your-project
   letta
   ```

Model inference is a separate choice. If you connect a remote model provider, prompts still go to that provider. To keep inference local too, connect a local provider such as Ollama, LM Studio, or llama.cpp. See [Local models](/configuration/models#local-models/index.md) for both local and cloud-hosted setup options.

## Agent SDK

The [Letta Agent SDK](/agent-sdk/index.md) supports two backends for self-hosted setups:

- **Local backend** (`backend: "local"`): The SDK starts [App Server](/self-hosting/app-server/index.md) automatically as a subprocess on the current machine. Agent state and the execution environment stay on the machine running your code. Use this for development or single-machine deployments—no separate server process to manage.
- **Remote backend** (`backend: "remote"`): The SDK connects to an App Server you run as a separate service (`letta server --listen`). Agent state and the execution environment live on the App Server machine, so multiple clients can share the same agents and the server can run on different infrastructure than your application.

* [Local backend](#tab-panel-8)
* [Remote backend](#tab-panel-9)

```
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";


const client = new LettaAgentClient({ backend: "local" });


const agentId = await client.createAgent({
  persona: "You are Patch, a resident engineering teammate for this repository.",
});


await using session = client.createSession(agentId, {
  cwd: process.cwd(),
});


await session.send("Inspect this repository and write an onboarding memo.");


for await (const message of session.stream()) {
  if (message.type === "assistant") {
    console.log(message.content);
  }
}
```

Start an App Server on the machine that should hold agent state:

```
letta server --backend local --listen ws://127.0.0.1:4500
```

Then connect to it from your application:

```
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";


const client = new LettaAgentClient({
  backend: "remote",
  url: process.env.LETTA_APP_SERVER_URL ?? "http://127.0.0.1:4500",
  authToken: process.env.LETTA_APP_SERVER_TOKEN,
});


const agentId = await client.createAgent({
  persona: "You are Ops, a digital employee running in a shared workspace.",
});


await using session = client.createSession(agentId, {
  cwd: "/workspace/project",
});


await session.send("Prepare a morning handoff report for the workspace.");


for await (const message of session.stream()) {
  if (message.type === "assistant") {
    console.log(message.content);
  }
}
```

See the [Agent SDK docs](/agent-sdk/index.md) for full setup instructions and [Deployment](/agent-sdk/deployment/index.md) for production configurations.

For OpenAI-compatible clients, see the [App Server quickstart](/self-hosting/app-server/quickstart#openai-compatible-api/index.md).

## Deployment

The [App Server deployment repository](https://github.com/letta-ai/letta-app-server-deployment) contains one Dockerfile plus ready-to-use configuration for Docker Compose, Railway, and Fly.io. It runs App Server with the local backend, so agent state, memory, and tool execution stay on the deployed machine.

### Docker Compose

```
git clone https://github.com/letta-ai/letta-app-server-deployment.git
cd letta-app-server-deployment
cp .env.example .env
```

Set `LETTA_APP_SERVER_TOKEN` and at least one model provider key in `.env`, then start the service:

```
docker compose up --build -d
docker compose logs -f
curl http://127.0.0.1:4500/readyz
```

The Compose file exposes port `4500` and creates persistent volumes for `/root/.letta` and `/workspace`.

### Railway

1. Fork the [deployment repository](https://github.com/letta-ai/letta-app-server-deployment).
2. Create a Railway project from the fork. Railway detects its `Dockerfile` and `railway.json`.
3. Add `LETTA_APP_SERVER_TOKEN` and a model provider key, such as `ANTHROPIC_API_KEY`, as Railway variables.
4. Add a persistent volume mounted at `/root/.letta`.
5. Generate a public domain for the service.

Railway terminates TLS, forwards WebSocket connections to App Server, and checks `/readyz` during deploys.

### Fly.io

```
git clone https://github.com/letta-ai/letta-app-server-deployment.git
cd letta-app-server-deployment
fly launch --name your-letta-app-server --no-deploy
fly volumes create letta_state --region sjc --size 1


export LETTA_APP_SERVER_TOKEN="$(openssl rand -hex 32)"
fly secrets set \
  LETTA_APP_SERVER_TOKEN="$LETTA_APP_SERVER_TOKEN" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"
fly deploy
```

The included `fly.toml` mounts the volume at `/root/.letta`, exposes App Server through Fly’s HTTPS proxy, and checks `/readyz`.

### Other container platforms

Deploy the repository anywhere that accepts a Dockerfile. Expose the container’s `PORT` (default `4500`), persist `/root/.letta`, set `LETTA_APP_SERVER_TOKEN` and a model provider key, and route HTTPS or WSS traffic to the service. Use `/readyz` as the health check.

### Connect your application

```
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";


const client = new LettaAgentClient({
  backend: "remote",
  url: process.env.LETTA_APP_SERVER_URL,
  authToken: process.env.LETTA_APP_SERVER_TOKEN,
});
```

App Server has shell and filesystem access on its host. Keep its token in your application’s backend or secret store rather than exposing it to browser clients. See [App Server](/self-hosting/app-server/index.md) for protocol and authentication details.

## Where local state is stored

By default, local state is stored in:

```
~/.letta/lc-local-backend
```

Each agent’s MemFS repository is stored under:

```
~/.letta/lc-local-backend/memfs/<agent-id>/memory
```

Use `LETTA_LOCAL_BACKEND_DIR` to isolate local state for a project or experiment:

```
export LETTA_LOCAL_BACKEND_DIR="$PWD/.letta-local"
letta --backend local --new-agent
```

Add `.letta-local/` to `.gitignore` if you create it inside a repository.

## Troubleshooting

### My prompts are still going to a remote provider

Local setup stores agent state locally, but inference follows the model provider you selected. Switch to an Ollama, LM Studio, or llama.cpp model to run inference locally.

### My local model does not appear in `/model`

Make sure the local inference server is running, then reconnect the provider:

```
letta --backend local connect ollama
letta --backend local connect lmstudio --base-url http://127.0.0.1:1234/v1
```

### I want a clean local setup for testing

Set `LETTA_LOCAL_BACKEND_DIR` to a temporary directory before launching Letta Code:

```
export LETTA_LOCAL_BACKEND_DIR="$(mktemp -d)"
letta --backend local --new-agent
```
