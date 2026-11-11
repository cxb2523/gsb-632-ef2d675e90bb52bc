import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { initDB, get, query, run } from "../src/server/db";
import { backfillHighlights, libraryHighlights } from "../src/server/library-highlights";
import { saveVerdict } from "../src/server/highlights";

let db: DatabaseSync;

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  initDB({
    STORAGE: {
      async query(sql: string, params: unknown[] = []) {
        const s = db.prepare(sql);
        if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql)) return { rows: s.all(...(params as never[])) };
        const r = s.run(...(params as never[]));
        return { rows: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    },
  });
  db.prepare("INSERT INTO assets (id, key, name, content_type, size, duration) VALUES ('a1', 'media/a1', 'talk.mp4', 'video/mp4', 100, 600)").run();
  db.prepare("INSERT INTO edit_projects (id, name, edl) VALUES ('p1', 'Project', '{}')").run();
  db.prepare("INSERT INTO project_footage (id, project_id, drive_file_id, name, status, asset_id, log_status) VALUES ('f1', 'p1', 'd1', 'talk.mp4', 'ready', 'a1', 'done')").run();
});

interface CatalogItem {
  id: string;
  asset_id: string;
  kind: string;
  src_in: number;
  src_out: number;
  text: string;
  speaker: string;
  deleted_at?: string | null;
}

const catalog = async (params = "") => {
  const r = await libraryHighlights.request(`/${params}`, {});
  expect(r.status).toBe(200);
  return (await r.json()) as { items: CatalogItem[]; next_offset: number | null };
};

const remove = async (id: string) => {
  const r = await libraryHighlights.request(`/${id}`, { method: "DELETE" });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

/** A pick as a person adds it (POST /api/projects/:id/highlights/items runs this statement). */
const personPick = (id: string, kind: string, start: number, end: number, text: string) =>
  db
    .prepare("INSERT INTO footage_highlights (id, project_id, footage_id, kind, src_in, src_out, text, score, reason, pick, origin) VALUES (?, 'p1', 'f1', ?, ?, ?, ?, 3, '', 'keep', 'person')")
    .run(id, kind, start, end, text);

/** An AI reading of the clip: how analysis publishes and republishes picks. */
const aiVerdict = (start: number, end: number, text: string, speaker = "") =>
  saveVerdict("p1", { id: "f1", skip: null, highlights: [{ kind: "soundbite", start, end, text, speaker, score: 4, reason: "strong" }] });

const tombstone = async () =>
  get<{ id: string; deleted_at: string | null }>("SELECT id, deleted_at FROM library_highlights WHERE asset_id = 'a1' AND kind = 'soundbite' AND src_in = 3 AND src_out = 10");

describe("shared highlight deletion", () => {
  it("tombstones a highlight: hidden from the catalog, observable, durable", async () => {
    await aiVerdict(3, 10, "Shipping fast is the whole point.", "Ada");
    const before = await catalog();
    expect(before.items).toHaveLength(1);

    const gone = await remove(before.items[0].id);
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ ok: true, id: before.items[0].id });
    expect(typeof gone.body.deleted_at).toBe("string");

    expect((await catalog()).items).toHaveLength(0);
    // The tombstone is a row, not an absence: it survives restarts and stays queryable.
    expect((await tombstone())?.deleted_at).not.toBeNull();

    // Deleting again is idempotent and reports the same tombstone; unknown ids 404.
    const again = await remove(before.items[0].id);
    expect(again.status).toBe(200);
    expect(again.body.deleted_at).toBe(gone.body.deleted_at);
    expect((await remove("no-such-id")).status).toBe(404);

    // An interrupted legacy backfill after a restart cannot resurrect it either.
    await run("DELETE FROM app_settings WHERE key = 'library_highlights_v1'");
    await backfillHighlights();
    expect((await catalog()).items).toHaveLength(0);
    expect(await query("SELECT id FROM library_highlights")).toHaveLength(1);
  });

  it("never republishes a deleted range when the same clip is analyzed again", async () => {
    await aiVerdict(3, 10, "Shipping fast is the whole point.", "Ada");
    const [item] = (await catalog()).items;
    await remove(item.id);

    // The same reading lands again (the project still has its pick replaced).
    await aiVerdict(3, 10, "Shipping fast is the whole point.", "Ada");
    expect((await catalog()).items).toHaveLength(0);
    expect((await tombstone())?.deleted_at).not.toBeNull();
    expect(await query("SELECT id FROM library_highlights")).toHaveLength(1);
    // The project's own picks are untouched by the shared deletion.
    expect(await get("SELECT id FROM footage_highlights WHERE footage_id = 'f1' AND src_in = 3")).toBeTruthy();

    // A genuinely different range from the same clip is not caught by the tombstone.
    await aiVerdict(20, 27, "A different moment.");
    const after = await catalog();
    expect(after.items).toHaveLength(1);
    expect(after.items[0].src_in).toBe(20);
  });

  it("lets a person explicitly re-publish the deleted range", async () => {
    await aiVerdict(3, 10, "Shipping fast is the whole point.", "Ada");
    const [item] = (await catalog()).items;
    await remove(item.id);
    expect((await catalog()).items).toHaveLength(0);

    personPick("person-1", "soundbite", 3, 10, "Shipping fast is the whole point.");
    const restored = await catalog();
    expect(restored.items).toHaveLength(1);
    expect(restored.items[0]).toMatchObject({ src_in: 3, src_out: 10, text: "Shipping fast is the whole point." });
    expect((await tombstone())?.deleted_at).toBeNull();

    // And once restored, a later automatic reading leaves it alone (no duplicate).
    await aiVerdict(3, 10, "Shipping fast is the whole point.", "Ada");
    expect((await catalog()).items).toHaveLength(1);
    expect(await query("SELECT id FROM library_highlights")).toHaveLength(1);
  });

  it("keeps projects started from a highlight when the highlight is removed", async () => {
    await aiVerdict(3, 10, "Shipping fast is the whole point.", "Ada");
    const [item] = (await catalog()).items;

    const made = await libraryHighlights.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [item.id], request_id: "request-0000000001" }),
    });
    expect(made.status).toBe(201);
    const { projects } = (await made.json()) as { projects: { id: string }[] };
    expect(projects).toHaveLength(1);

    await remove(item.id);
    // The timeline clip is a copy: removing the shared entry never touches it.
    expect(await get("SELECT id FROM edit_projects WHERE id = ?", [projects[0].id])).toBeTruthy();
    expect((await catalog()).items).toHaveLength(0);

    // But a deleted highlight can no longer start new projects.
    const again = await libraryHighlights.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [item.id], request_id: "request-0000000002" }),
    });
    expect(again.status).toBe(409);
  });
});

describe("catalog pagination and search after deletion", () => {
  const seed = (n: number) => {
    for (let i = 0; i < n; i++) {
      db.prepare("INSERT INTO footage_highlights (id, project_id, footage_id, kind, src_in, src_out, text, origin) VALUES (?, 'p1', 'f1', 'broll', ?, ?, ?, 'ai')").run(
        `h${String(i).padStart(3, "0")}`,
        i * 2,
        i * 2 + 1,
        `pick ${i}`,
      );
    }
  };

  it("pages without duplicates or omissions when a fetched row is removed", async () => {
    seed(50);
    const first = await catalog();
    expect(first.items).toHaveLength(48);
    expect(first.next_offset).toBe(48);

    // Remove one of the fetched rows; the client steps next_offset down by one.
    const removed = first.items[5];
    await remove(removed.id);
    const rest = await catalog(`?offset=${first.next_offset! - 1}`);
    expect(rest.next_offset).toBeNull();

    // Everything ever shown plus the shifted-up tail: no row seen twice, none lost.
    const seen = [...first.items, ...rest.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(50);
    // The row that sat just past the page boundary is not skipped.
    expect(rest.items.map((i) => i.id)).toEqual(["h001", "h000"]);
    // Without the client's offset adjustment the boundary row would be omitted.
    expect((await catalog("?offset=48")).items.map((i) => i.id)).toEqual(["h000"]);
  });

  it("keeps search results consistent after a delete", async () => {
    seed(50);
    const before = await catalog("?search=pick");
    expect(before.items).toHaveLength(48);
    await remove(before.items[0].id);

    const gone = await catalog(`?search=${encodeURIComponent("pick 49")}`);
    expect(gone.items).toHaveLength(0);
    const page1 = await catalog("?search=pick");
    expect(page1.items).toHaveLength(48);
    expect(page1.next_offset).toBe(48);
    const page2 = await catalog(`?search=pick&offset=${page1.next_offset}`);
    expect(page2.items).toHaveLength(1);
    expect(page2.next_offset).toBeNull();
    const found = [...page1.items, ...page2.items];
    expect(new Set(found.map((i) => i.id)).size).toBe(49);
    expect(found.some((i) => i.text === "pick 49")).toBe(false);
  });
});
