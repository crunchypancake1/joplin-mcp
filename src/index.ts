import { JoplinMCP } from "./agent.js";
import { runIndexer } from "./indexer.js";
import type { Env } from "./types.js";

export { JoplinMCP };

const mcpHandler = JoplinMCP.mount("/mcp");

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return mcpHandler.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIndexer(env));
  },
} satisfies ExportedHandler<Env>;
