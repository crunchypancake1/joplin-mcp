export interface Env {
  JOPLIN_MCP: DurableObjectNamespace;
  // Joplin client base URL (e.g. https://joplin.crunchypancake.com)
  JOPLIN_CLIENT_URL: string;
  // Joplin Data API token — set via: wrangler secret put JOPLIN_API_TOKEN
  JOPLIN_API_TOKEN: string;
}
