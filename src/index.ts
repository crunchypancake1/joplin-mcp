import { JoplinMCP } from "./agent.js";
import { runIndexer } from "./indexer.js";
import type { Env } from "./types.js";

export { JoplinMCP };

export default {
  ...JoplinMCP.serve("/mcp", { binding: "JOPLIN_MCP" }),
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIndexer(env));
  },
};
