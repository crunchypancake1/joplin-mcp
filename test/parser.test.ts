import { describe, it, expect } from "vitest";
import { parseJoplinItem } from "../src/parser.js";

const EMPTY_BODY_FIXTURE = `Test Note

id: 29847587f24a4319bc6aaae7226e79e0
parent_id: 7736fb661409465e827bbe0d8b57ac4c
created_time: 2026-05-30T13:53:52.848Z
updated_time: 2026-05-30T13:53:57.242Z
is_conflict: 0
latitude: 0.00000000
longitude: 0.00000000
altitude: 0.0000
author:
source_url:
is_todo: 0
todo_due: 0
todo_completed: 0
source: joplin
source_application: net.cozic.joplin-mobile
application_data:
order: 1780149232848
user_created_time: 2026-05-30T13:53:52.848Z
user_updated_time: 2026-05-30T13:53:57.242Z
encryption_cipher_text:
encryption_applied: 0
markup_language: 1
is_shared: 0
share_id:
conflict_original_id:
master_key_id:
user_data:
deleted_time: 0
type_: 1`;

const WITH_BODY_FIXTURE = `My Note With Content

This is the note body.
It has multiple lines.

And a blank line in the middle.

id: aaaabbbbccccdddd00001111222233334444
parent_id: 7736fb661409465e827bbe0d8b57ac4c
created_time: 2026-01-01T00:00:00.000Z
updated_time: 2026-01-02T00:00:00.000Z
is_conflict: 0
latitude: 0.00000000
longitude: 0.00000000
altitude: 0.0000
author:
source_url:
is_todo: 0
todo_due: 0
todo_completed: 0
source: joplin
source_application: net.cozic.joplin-desktop
application_data:
order: 0
user_created_time: 2026-01-01T00:00:00.000Z
user_updated_time: 2026-01-02T00:00:00.000Z
encryption_cipher_text:
encryption_applied: 0
markup_language: 1
is_shared: 0
share_id:
conflict_original_id:
master_key_id:
user_data:
deleted_time: 0
type_: 1`;

const FOLDER_FIXTURE = `My Notebook

id: 7736fb661409465e827bbe0d8b57ac4c
parent_id:
created_time: 2026-01-01T00:00:00.000Z
updated_time: 2026-01-01T00:00:00.000Z
user_created_time: 2026-01-01T00:00:00.000Z
user_updated_time: 2026-01-01T00:00:00.000Z
encryption_applied: 0
deleted_time: 0
type_: 2`;

const DELETED_NOTE_FIXTURE = `Deleted Note

id: deadbeef00000000000000000000000000
parent_id: 7736fb661409465e827bbe0d8b57ac4c
created_time: 2026-01-01T00:00:00.000Z
updated_time: 2026-01-05T00:00:00.000Z
is_conflict: 0
latitude: 0.00000000
longitude: 0.00000000
altitude: 0.0000
author:
source_url:
is_todo: 0
todo_due: 0
todo_completed: 0
source: joplin
source_application: net.cozic.joplin-desktop
application_data:
order: 0
user_created_time: 2026-01-01T00:00:00.000Z
user_updated_time: 2026-01-05T00:00:00.000Z
encryption_cipher_text:
encryption_applied: 0
markup_language: 1
is_shared: 0
share_id:
conflict_original_id:
master_key_id:
user_data:
deleted_time: 1746393600000
type_: 1`;

describe("parseJoplinItem", () => {
  it("parses a note with empty body", () => {
    const item = parseJoplinItem(EMPTY_BODY_FIXTURE);
    expect(item.title).toBe("Test Note");
    expect(item.body).toBe("");
    expect(item.id).toBe("29847587f24a4319bc6aaae7226e79e0");
    expect(item.parent_id).toBe("7736fb661409465e827bbe0d8b57ac4c");
    expect(item.type_).toBe(1);
    expect(item.deleted_time).toBe(0);
    expect(item.created_time).toBe("2026-05-30T13:53:52.848Z");
    expect(item.updated_time).toBe("2026-05-30T13:53:57.242Z");
  });

  it("parses a note with a multi-line body", () => {
    const item = parseJoplinItem(WITH_BODY_FIXTURE);
    expect(item.title).toBe("My Note With Content");
    expect(item.body).toBe(
      "This is the note body.\nIt has multiple lines.\n\nAnd a blank line in the middle."
    );
    expect(item.id).toBe("aaaabbbbccccdddd00001111222233334444");
    expect(item.type_).toBe(1);
    expect(item.deleted_time).toBe(0);
  });

  it("parses a folder item (type_ == 2)", () => {
    const item = parseJoplinItem(FOLDER_FIXTURE);
    expect(item.title).toBe("My Notebook");
    expect(item.type_).toBe(2);
    expect(item.id).toBe("7736fb661409465e827bbe0d8b57ac4c");
    expect(item.body).toBe("");
  });

  it("parses a deleted note (deleted_time != 0)", () => {
    const item = parseJoplinItem(DELETED_NOTE_FIXTURE);
    expect(item.type_).toBe(1);
    expect(item.deleted_time).not.toBe(0);
    expect(item.deleted_time).toBeGreaterThan(0);
  });

  it("preserves unknown/future metadata keys without throwing", () => {
    const withFutureKey = EMPTY_BODY_FIXTURE + "\nfuture_key: some_value";
    expect(() => parseJoplinItem(withFutureKey)).not.toThrow();
    const item = parseJoplinItem(withFutureKey);
    expect(item.meta["future_key"]).toBe("some_value");
  });
});
