import { parseJoplinItem } from "./parser.js";
import { R2SearchSink } from "./sink.js";
import type { Env, NormalizedDoc, NotebookConfig } from "./types.js";

const CURSOR_KEY = "cursor:joplin:updated_time";
const CONFIG_KEY = "config:joplin:indexed-notebooks";

// Joplin sync metadata paths — not note content
const SKIP_PREFIXES = [".sync/", "locks/", "temp/", "info.json"];

export async function runIndexer(env: Env): Promise<void> {
  const sink = new R2SearchSink(env.SINK_BUCKET);

  // Load notebook allowlist config (default: index all notebooks)
  const configRaw = await env.JOPLIN_KV.get(CONFIG_KEY);
  const config: NotebookConfig = configRaw
    ? JSON.parse(configRaw)
    : { mode: "allowlist", notebookIds: [] };

  // Load cursor: timestamp (ms) of the last processed R2 object's uploaded date
  const cursorRaw = await env.JOPLIN_KV.get(CURSOR_KEY);
  const cursorMs = cursorRaw ? parseInt(cursorRaw, 10) : 0;

  // Paginate through ALL objects in the sync bucket
  const allObjects: R2Object[] = [];
  let listCursor: string | undefined;
  do {
    const listed: R2Objects = await env.JOPLIN_NOTES.list(
      listCursor ? { cursor: listCursor } : {}
    );
    allObjects.push(...listed.objects);
    listCursor = listed.truncated ? listed.cursor : undefined;
  } while (listCursor);

  // Filter out Joplin internal paths (not note/folder item files)
  const itemObjects = allObjects.filter(
    (o) => !SKIP_PREFIXES.some((p) => o.key.startsWith(p))
  );

  // Download and parse all item objects
  const parsedRaw = await Promise.all(
    itemObjects.map(async (obj) => {
      const r2obj = await env.JOPLIN_NOTES.get(obj.key);
      if (!r2obj) return null;
      const text = await r2obj.text();
      try {
        const item = parseJoplinItem(text);
        return { item, uploadedMs: obj.uploaded.getTime() };
      } catch {
        console.warn(`[joplin-indexer] Failed to parse item: ${obj.key}`);
        return null;
      }
    })
  );
  const parsed = parsedRaw.filter(
    (r): r is { item: ReturnType<typeof parseJoplinItem>; uploadedMs: number } => r !== null
  );

  // Build folder (notebook) id → name map from all folder items
  const folderMap = new Map<string, string>();
  for (const { item } of parsed) {
    if (item.type_ === 2) {
      folderMap.set(item.id, item.title);
    }
  }

  // Process note items
  const toUpsert: NormalizedDoc[] = [];
  const toRemove: string[] = [];
  let maxUploadedMs = cursorMs;

  for (const { item, uploadedMs } of parsed) {
    if (item.type_ !== 1) continue; // only notes

    // Only reprocess items uploaded after the cursor (skip unchanged notes)
    if (uploadedMs <= cursorMs) continue;

    maxUploadedMs = Math.max(maxUploadedMs, uploadedMs);

    const docId = `joplin:${item.id}`;

    // Check deletion BEFORE notebook filter: a deleted note should be removed from the
    // sink even if its notebook was subsequently removed from the allowlist.
    if (item.deleted_time !== 0) {
      toRemove.push(docId);
      continue;
    }

    // Apply notebook allowlist/denylist
    if (!isNotebookAllowed(item.parent_id, config)) continue;

    toUpsert.push(normalizeNote(item, folderMap.get(item.parent_id)));
  }

  // Flush changes to sink
  if (toRemove.length > 0) {
    await sink.remove(toRemove);
  }

  // Upsert in batches of 50
  for (let i = 0; i < toUpsert.length; i += 50) {
    await sink.upsert(toUpsert.slice(i, i + 50));
  }

  // Advance cursor if we processed anything new
  if (maxUploadedMs > cursorMs) {
    await env.JOPLIN_KV.put(CURSOR_KEY, String(maxUploadedMs));
  }

  console.log(
    `[joplin-indexer] upserted=${toUpsert.length} removed=${toRemove.length} cursor=${maxUploadedMs}`
  );
}

function isNotebookAllowed(notebookId: string, config: NotebookConfig): boolean {
  if (config.notebookIds.length === 0) return true; // empty list = all notebooks
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
