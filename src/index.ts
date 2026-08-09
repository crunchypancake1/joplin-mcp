import { JoplinMCP } from "./agent.js";

export { JoplinMCP };

export default JoplinMCP.serve("/mcp", { binding: "JOPLIN_MCP" });
