import { parseJoplinItem } from "./parser.js";
import { R2SearchSink } from "./sink.js";
import type { Env, NormalizedDoc, NotebookConfig } from "./types.js";
import { JOPLIN_SKIP_PREFIXES, JOPLIN_INFO_KEY } from "./types.js";

const CONFIG_KEY = "config:joplin:indexed-notebooks";

export async function processR2Event(
  key: string,
  action: string,
  env: Env
): Promise<void> {
  const sink = new R2SearchSink(env.SINK_BUCKET);

  if (action === "DeleteObject") {
    const noteId = key.replace(/\.md$/, "");
    await sink.remove([`joplin:${noteId}`]);
    return;
  }

  if (
    JOPLIN_SKIP_PREFIXES.some((p) => key.startsWith(p)) ||
    key === JOPLIN_INFO_KEY
  ) {
    return;
  }

  const r2obj = await env.JOPLIN_NOTES.get(key);
  if (!r2obj) return;

  const text = await r2obj.text();
  let item: ReturnType<typeof parseJoplinItem>;
  try {
    item = parseJoplinItem(text);
  } catch {
    console.warn(`[joplin-indexer] Failed to parse item: ${key}`);
    return;
  }

  if (item.type_ !== 1) return;
  if (!item.id) return;

  const docId = `joplin:${item.id}`;

  if (item.deleted_time !== 0) {
    await sink.remove([docId]);
    return;
  }

  const configRaw = await env.JOPLIN_KV.get(CONFIG_KEY);
  const config: NotebookConfig = configRaw
    ? JSON.parse(configRaw)
    : { mode: "allowlist", notebookIds: [] };

  if (!isNotebookAllowed(item.parent_id, config)) return;

  const notebookName = await resolveNotebookName(item.parent_id, env);
  await sink.upsert([normalizeNote(item, notebookName)]);

  console.log(`[joplin-indexer] upserted noteId=${item.id}`);
}

async function resolveNotebookName(
  parentId: string,
  env: Env
): Promise<string | undefined> {
  if (!parentId) return undefined;
  try {
    const folderObj = await env.JOPLIN_NOTES.get(`${parentId}.md`);
    if (!folderObj) return undefined;
    const text = await folderObj.text();
    const folder = parseJoplinItem(text);
    return folder.title || undefined;
  } catch {
    return undefined;
  }
}

function isNotebookAllowed(notebookId: string, config: NotebookConfig): boolean {
  if (config.notebookIds.length === 0) return true;
  if (config.mode === "allowlist") return config.notebookIds.includes(notebookId);
  if (config.mode === "denylist") return !config.notebookIds.includes(notebookId);
  return true;
}

function normalizeNote(
  item: ReturnType<typeof parseJoplinItem>,
  notebookName: string | undefined
): NormalizedDoc {
  return {
    id: `joplin:${item.id}`,
    source: "joplin",
    title: item.title,
    url: `joplin://x-callback-url/openNote?id=${item.id}`,
    content: item.body,
    metadata: {
      notebook: notebookName,
      notebookId: item.parent_id,
      createdAt: item.created_time,
      updatedAt: item.updated_time,
    },
  };
}
