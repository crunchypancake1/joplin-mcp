export interface Env {
  JOPLIN_MCP: DurableObjectNamespace;
  // Joplin client base URL (e.g. https://joplin.crunchypancake.com)
  JOPLIN_CLIENT_URL: string;
  // Joplin Data API token — Secrets Store binding, read via JOPLIN_API_TOKEN.get()
  JOPLIN_API_TOKEN: SecretsStoreSecret;
}
