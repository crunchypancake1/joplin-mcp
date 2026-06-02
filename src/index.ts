import { JoplinMCP } from "./agent.js";
import { processR2Event } from "./indexer.js";
import type { Env } from "./types.js";

export { JoplinMCP };

export default {
  ...JoplinMCP.serve("/mcp", { binding: "JOPLIN_MCP" }),
  async queue(batch: MessageBatch<{ key: string; action: string }>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      await processR2Event(msg.body.key, msg.body.action, env);
      msg.ack();
    }
  },
};
