import { JoplinMCP } from "./agent.js";
import { processR2Event } from "./indexer.js";
import type { Env, R2EventNotificationMessage } from "./types.js";

export { JoplinMCP };

export default {
  ...JoplinMCP.serve("/mcp", { binding: "JOPLIN_MCP" }),
  async queue(
    batch: MessageBatch<R2EventNotificationMessage>,
    env: Env
  ): Promise<void> {
    await Promise.all(
      batch.messages.map(async (msg) => {
        try {
          await processR2Event(msg.body.object.key, msg.body.action, env);
          msg.ack();
        } catch (err) {
          console.error(
            `[joplin-indexer] Failed to process event for ${msg.body.object.key}:`,
            err
          );
          msg.retry();
        }
      })
    );
  },
};
