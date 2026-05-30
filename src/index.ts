export default {
  fetch: (_req: Request) => new Response("Joplin MCP Worker"),
  async scheduled(_event: ScheduledEvent, _env: unknown, _ctx: ExecutionContext): Promise<void> {},
};
