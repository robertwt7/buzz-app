import { createSoloPreferences } from "./solo-preferences";
import { TEAM_MANIFEST_TAG } from "../channel-templates/team-payload";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  KIT_TAG,
  coordinate,
  LEADS_TAG,
  leadsCoordinate,
  ME_KIT_TAG,
  kitRecordFits,
  parseKitRecord,
  privateCoordinate,
  privateTag,
  type Groups,
  type KitRecord,
  type KitValue,
  type Template,
  type PrivateRecord,
} from "../channel-templates/model";
import { projectTemplateId, templateEntry } from "../solo/workspace";
import leadCases from "../channel-templates/workspace-leads-admission-contract.json";
import { matchesEvent } from "./projection";
import { flush, keypair, roster, scriptedTransport, signed } from "./testing";
import type { ReadFilter, RelayEvent } from "./events";
import type { SidebarPreferences } from "./sidebar-preferences";

afterEach(() => vi.restoreAllMocks());

const channel = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const community = "https://primary.example";
const groups: Groups = {
  type: "groups",
  id: "me",
  groups: [{ id: "work", name: "Solo work", defaultTemplateId: "template" }],
  assignments: { [other]: "work" },
};
function fixture() {
  const viewer = keypair(),
    relay = keypair();
  let time = 1_700_000_000;
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
  const events: RelayEvent[] = [];
  let legacy: SidebarPreferences = {
    sections: [{ id: "work", name: "OG work", icon: "★", order: 0 }],
    assignments: { [channel]: "work" },
    starred: [],
    muted: [],
  };
  const installRecord = (record: PrivateRecord, createdAt = time++) =>
    events.push(
      signed(viewer, {
        kind: 30078,
        created_at: createdAt,
        tags: [
          ["d", privateCoordinate(record)],
          ["t", privateTag(record)],
        ],
        content: JSON.stringify(record),
      }),
    );
  const install = (value: KitValue, deleted = false, createdAt?: number) => {
    const record: KitRecord = { version: 1, community, deleted, value };
    installRecord(record, createdAt);
  };
  const leadReads: {
    fail: false | Error;
    /** Holds the next Leads read after it has selected its rows. */
    hold?: Promise<void> | undefined;
    /** Runs once as the next Leads read starts: another device's writes. */
    before?: (() => void) | undefined;
  } = { fail: false };
  const query = vi.fn(async (filters: readonly ReadFilter[]) => {
    const leads = filters.some((filter) =>
      filter["#d"]?.includes(leadsCoordinate(community)),
    );
    if (leads && leadReads.fail) throw leadReads.fail;
    const before = leads ? leadReads.before : undefined;
    if (before) {
      leadReads.before = undefined;
      before();
    }
    const rows = events.filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    );
    const hold = leads ? leadReads.hold : undefined;
    if (hold) {
      leadReads.hold = undefined;
      await hold;
    }
    return rows;
  });
  const assignment = vi.fn(async (intent) => {
    const assignments = { ...legacy.assignments };
    if (intent.sectionId) assignments[intent.channelId] = intent.sectionId;
    else delete assignments[intent.channelId];
    legacy = { ...legacy, assignments };
    return legacy;
  });
  const removal = vi.fn(async (sectionId: string) => {
    legacy = {
      ...legacy,
      sections: legacy.sections.filter(({ id }) => id !== sectionId),
      assignments: Object.fromEntries(
        Object.entries(legacy.assignments).filter(([, id]) => id !== sectionId),
      ),
    };
    return legacy;
  });
  const star = vi.fn(async ({ channelId, starred }) => {
    legacy = { ...legacy, starred: starred ? [channelId] : [] };
    return legacy.starred;
  });
  const sort = vi.fn(async () => ({}));
  const publish = vi.fn(async (event: RelayEvent) => {
    events.push(event);
  });
  const prepare = vi.fn(async (record: KitRecord, _signal: AbortSignal) =>
    JSON.stringify(record),
  );
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: community,
      media: () => undefined,
      query,
      decodeSidebarPreferences: async () => legacy,
      writeSidebarAssignment: assignment,
      removeSidebarSection: removal,
      writeSidebarStar: star,
      writeSidebarSort: sort,
      channelKit: {
        decode: async (rows) =>
          rows.map((event) => ({
            eventId: event.id,
            record: JSON.parse(event.content),
          })),
        prepare,
      },
      writer: {
        kinds: [30078],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: async () => [], save: async () => {} } },
  );
  return {
    ...owner,
    query,
    assignment,
    removal,
    sort,
    star,
    publish,
    prepare,
    install,
    installRecord,
    leadReads,
    events,
    preferences: owner.session.sidebarPreferences,
  };
}

it("retries a catalog read cancelled by initial roster authority", async () => {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    channelKit: { decode: async () => [], prepare: async () => "" },
  });
  try {
    const catalog = owner.session.channelKit.refresh();
    await flush();
    const interrupted = wire.next();
    expect(interrupted.filters[0]?.["#t"]).toEqual([
      KIT_TAG,
      TEAM_MANIFEST_TAG,
      ME_KIT_TAG,
    ]);
    owner.session.channels.ensureList();
    await flush();
    wire.next().respond([roster(relay, channel, [viewer.pubkey])]);
    await flush();
    expect(interrupted.signal?.aborted).toBe(true);
    const retry = wire.pending.find((entry) => entry.filters[0]?.["#t"]);
    expect(retry?.filters).toEqual(interrupted.filters);
    for (const entry of wire.pending.splice(0)) entry.respond([]);
    await catalog;
    expect(owner.session.channelKit.snapshot().status).toBe("ready");
  } finally {
    owner.dispose();
  }
});

it.each(["clearCache", "dispose"] as const)(
  "does not retry a catalog read cancelled by %s",
  async (action) => {
    const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      channelKit: { decode: async () => [], prepare: async () => "" },
    });
    try {
      const catalog = owner.session.channelKit.refresh();
      await flush();
      const interrupted = wire.next();
      owner[action]();
      await catalog;
      await flush();
      expect(interrupted.signal?.aborted).toBe(true);
      expect(wire.pending).toHaveLength(0);
    } finally {
      owner.dispose();
    }
  },
);

it("starts Solo preferences empty and changes only the distinct Solo catalog coordinate", async () => {
  const f = fixture();
  const controller = new AbortController();
  const solo = createSoloPreferences(f.session.channelKit, controller.signal);
  try {
    await solo.queries.ensure();
    expect(solo.queries.snapshot().data?.sections).toEqual([]);
    await solo.queries.createAndAssign(channel, {
      id: "work",
      name: "Solo work",
    });
    expect(solo.queries.snapshot().data?.assignments).toEqual({
      [channel]: "work",
    });
    expect(solo.queries.starWritable).toBe(false);
    const writes = f.publish.mock.calls.map(([event]) => event);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.tags).toContainEqual(["t", ME_KIT_TAG]);
    expect(
      writes[0] &&
        matchesEvent(writes[0], {
          "#t": [KIT_TAG, TEAM_MANIFEST_TAG],
          limit: 500,
        }),
    ).toBe(false);
    await f.preferences.ensure();
    expect(f.preferences.snapshot().data?.sections[0]?.name).toBe("OG work");
    await solo.queries.removeSection("work");
    expect(solo.queries.snapshot().data?.sections).toEqual([]);
    expect(f.star).not.toHaveBeenCalled();
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    solo.dispose();
    f.dispose();
  }
});

it("retains Solo tombstone revision and never creates over an unread catalog", async () => {
  const f = fixture();
  f.install({ type: "groups", id: "me", groups: [], assignments: {} }, true);
  const controller = new AbortController();
  const solo = createSoloPreferences(f.session.channelKit, controller.signal);
  try {
    await expect(
      solo.queries.createAndAssign(channel, { id: "new", name: "New" }),
    ).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled();
    await solo.queries.ensure();
    await solo.queries.createAndAssign(channel, { id: "new", name: "New" });
    expect(solo.queries.snapshot().data?.sections[0]?.name).toBe("New");
  } finally {
    controller.abort();
    solo.dispose();
    f.dispose();
  }
});

it("invalidates the session-owned Solo projection on refreshed heads, including tombstones", async () => {
  const f = fixture();
  const solo = f.session.soloPreferences;
  const value: Groups = {
    type: "groups",
    id: "me",
    groups: [{ id: "work", name: "Solo work", defaultTemplateId: "" }],
    assignments: { [channel]: "work" },
  };
  try {
    await solo.ensure();
    await f.preferences.ensure();
    expect(solo.snapshot().data?.sections).toEqual([]);
    f.install(value);
    await f.session.channelKit.refresh();
    await vi.waitFor(() =>
      expect(solo.snapshot().data?.sections[0]?.name).toBe("Solo work"),
    );
    f.install({
      ...value,
      groups: [
        { id: "work", defaultTemplateId: "", name: "Renamed elsewhere" },
      ],
    });
    await f.session.channelKit.refresh();
    await vi.waitFor(() =>
      expect(solo.snapshot().data?.sections[0]?.name).toBe("Renamed elsewhere"),
    );
    f.install(value, true);
    await f.session.channelKit.refresh();
    await vi.waitFor(() => {
      expect(solo.snapshot().data?.sections).toEqual([]);
      expect(solo.snapshot().data?.assignments).toEqual({});
    });
    expect(f.preferences.snapshot().data?.sections[0]?.name).toBe("OG work");
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("drops the retired Solo channel list on the next project write", async () => {
  const f = fixture();
  try {
    f.install({ ...groups, channels: [channel, other] } as Groups);
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.assign(channel, "work");
    const value = JSON.parse(
      f.publish.mock.calls.at(-1)?.[0].content ?? "null",
    ).value;
    expect(value.channels).toBeUndefined();
    expect(value.assignments).toEqual({ [channel]: "work", [other]: "work" });
    expect(f.assignment).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it("does not overwrite project filing when a refresh fails, and reconciles retries against the fresh head", async () => {
  const f = fixture();
  try {
    f.install(groups);
    await f.session.soloPreferences.ensure();
    f.query.mockRejectedValueOnce(new Error("offline"));
    await expect(
      f.session.soloPreferences.assign(channel, "work"),
    ).rejects.toThrow();
    expect(f.publish).not.toHaveBeenCalled();
    await f.session.soloPreferences.assign(channel, "work");
    expect(f.session.soloPreferences.snapshot().data?.assignments).toEqual({
      [channel]: "work",
      [other]: "work",
    });
    const count = f.publish.mock.calls.length;
    await f.session.soloPreferences.assign(channel, "work");
    expect(f.publish).toHaveBeenCalledTimes(count);
  } finally {
    f.dispose();
  }
});

it("confirms native-shaped reordered assignment maps without losing group order", async () => {
  const f = fixture();
  try {
    f.install(groups);
    f.prepare.mockImplementation(async (record) =>
      JSON.stringify(record, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
            )
          : value,
      ),
    );
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.assign(channel, "work");
    expect(f.session.soloPreferences.snapshot().data?.assignments).toEqual({
      [channel]: "work",
      [other]: "work",
    });
    expect(f.publish).toHaveBeenCalledOnce();
  } finally {
    f.dispose();
  }
});

it("checks the exact project capacity before saving and reclaims a removed filing", async () => {
  const f = fixture();
  const value: Groups = {
    type: "groups",
    id: "me",
    groups: [{ id: "work", name: "Work", defaultTemplateId: "" }],
    assignments: {},
  };
  const record = () => ({
    version: 1 as const,
    community,
    deleted: false,
    value,
  });
  let id = "";
  for (let i = 1; i < 1000; i++) {
    id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    value.assignments[id] = "work";
    if (!kitRecordFits(record())) {
      delete value.assignments[id];
      break;
    }
  }
  parseKitRecord(record(), community);
  f.install(value);
  try {
    await f.session.soloPreferences.ensure();
    await expect(f.session.soloPreferences.assign(id, "work")).rejects.toThrow(
      "Solo workspace storage is full",
    );
    expect(f.publish).not.toHaveBeenCalled();
    const removed = Object.keys(value.assignments)[0];
    if (!removed) throw new Error("Missing filing");
    await f.session.soloPreferences.assign(removed, undefined);
    await f.session.soloPreferences.assign(id, "work");
    const assignments = f.session.soloPreferences.snapshot().data?.assignments;
    expect(assignments?.[id]).toBe("work");
    expect(assignments?.[removed]).toBeUndefined();
  } finally {
    f.dispose();
  }
});

const agent = "a".repeat(64);
const settings = async (projectId: string): Promise<Template> => ({
  type: "template",
  id: await projectTemplateId(projectId),
  name: "Solo work chats",
  description: "Starting workspace and Canvas for new chats in this workspace.",
  teamIds: [],
  agents: [agent],
  canvas: "## Project folders\n\n- `/src/launch`",
});
const workspaces: Groups = {
  type: "groups",
  id: "me",
  groups: [
    { id: "work", name: "Solo work", defaultTemplateId: "" },
    { id: "keep", name: "Kept", defaultTemplateId: "" },
  ],
  assignments: { [other]: "work" },
};
const written = (f: ReturnType<typeof fixture>) =>
  f.publish.mock.calls.map(([event]) => JSON.parse(event.content) as KitRecord);

it("tombstones only the removed workspace's settings, without their name, instructions, folders or agents", async () => {
  const f = fixture();
  try {
    const saved = await settings("work");
    const kept = await settings("keep");
    f.install(workspaces);
    f.install(saved);
    f.install(kept);
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.removeSection("work");
    expect(
      f.session.soloPreferences.snapshot().data?.sections.map(({ id }) => id),
    ).toEqual(["keep"]);
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
    const events = f.publish.mock.calls.map(([event]) => event);
    const record = (type: KitValue["type"]) => {
      const event = events.find(
        ({ content }) => JSON.parse(content).value.type === type,
      );
      return event && { event, record: JSON.parse(event.content) as KitRecord };
    };
    expect(record("groups")?.record).toEqual({
      version: 1,
      community,
      deleted: false,
      value: {
        ...workspaces,
        groups: workspaces.groups.slice(1),
        assignments: {},
      },
    });
    const tombstone = record("template");
    expect(tombstone?.record).toEqual({
      version: 1,
      community,
      deleted: true,
      value: { ...saved, name: "Deleted workspace", agents: [], canvas: "" },
    });
    expect(tombstone?.event.tags).toContainEqual([
      "d",
      coordinate({ version: 1, community, deleted: false, value: saved }),
    ]);
    await f.session.channelKit.refresh();
    const { entries } = f.session.channelKit.snapshot();
    expect(
      entries.find(({ record }) => record.value.id === saved.id)?.record
        .deleted,
    ).toBe(true);
    expect(templateEntry(entries, saved.id)).toBeUndefined();
    expect(templateEntry(entries, kept.id)?.record.value).toEqual(kept);
  } finally {
    f.dispose();
  }
});

it("resolves a removal before its tombstone and queues later writes behind it", async () => {
  const f = fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  try {
    f.install(workspaces);
    f.install(await settings("work"));
    f.prepare.mockImplementation(async (record) => {
      if (record.value.type === "template") {
        holding = true;
        await held;
      }
      return JSON.stringify(record);
    });
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.removeSection("work");
    await vi.waitFor(() => expect(holding).toBe(true));
    const created = f.session.soloPreferences.createSection({
      id: "next",
      name: "Next",
    });
    let settled = false;
    const settle = () => {
      settled = true;
    };
    void created.then(settle, settle);
    await flush();
    expect(settled).toBe(false);
    expect(f.publish).toHaveBeenCalledOnce();
    release();
    await expect(created).resolves.toBeUndefined();
    expect(written(f).map(({ value }) => value.type)).toEqual([
      "groups",
      "template",
      "groups",
    ]);
  } finally {
    release();
    f.dispose();
  }
});

it("saves another workspace's settings while a removed workspace's settings are deleted", async () => {
  const f = fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  try {
    const removed = await settings("work");
    const kept = await settings("keep");
    f.install(workspaces);
    f.install(removed);
    f.install(kept);
    f.prepare.mockImplementation(async (record) => {
      if (record.deleted) {
        holding = true;
        await held;
      }
      return JSON.stringify(record);
    });
    await f.session.soloPreferences.ensure();
    await f.session.soloPreferences.removeSection("work");
    await vi.waitFor(() => expect(holding).toBe(true));
    // Workspace settings save through the kit itself, outside the Solo queue.
    const edited = { ...kept, canvas: "## Project folders\n\n- `/src/kept`" };
    await f.session.channelKit.save(
      edited,
      templateEntry(f.session.channelKit.snapshot().entries, kept.id)?.eventId,
    );
    expect(
      templateEntry(f.session.channelKit.snapshot().entries, kept.id)?.record
        .value,
    ).toEqual(edited);
    release();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(3));
    expect(
      written(f).map(({ deleted, value }) => [value.type, value.id, deleted]),
    ).toEqual([
      ["groups", "me", false],
      ["template", kept.id, false],
      ["template", removed.id, true],
    ]);
  } finally {
    release();
    f.dispose();
  }
});

it("deletes the settings when a retried removal finds its unconfirmed groups write landed", async () => {
  const f = fixture();
  try {
    const removed = await settings("work");
    f.install(workspaces);
    f.install(removed);
    await f.session.soloPreferences.ensure();
    // The relay stores the groups write but never confirms it by id.
    const read = f.query.getMockImplementation();
    let unconfirmed = true;
    f.query.mockImplementation(async (filters) =>
      unconfirmed && filters.some(({ ids }) => ids)
        ? []
        : (read?.(filters) ?? []),
    );
    await expect(
      f.session.soloPreferences.removeSection("work"),
    ).rejects.toThrow("awaiting exact relay confirmation");
    expect(written(f).map(({ value }) => value.type)).toEqual(["groups"]);
    unconfirmed = false;
    await f.session.soloPreferences.removeSection("work");
    expect(
      f.session.soloPreferences.snapshot().data?.sections.map(({ id }) => id),
    ).toEqual(["keep"]);
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledTimes(2));
    expect(written(f)[1]).toMatchObject({
      deleted: true,
      value: { id: removed.id, name: "Deleted workspace" },
    });
  } finally {
    f.dispose();
  }
});

it("drops the tombstone when the preferences clear while it hashes the id", async () => {
  const f = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.install(workspaces);
    f.install(await settings("work"));
    await f.session.soloPreferences.ensure();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let hashing = false;
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      hashing = true;
      await held;
      return digest(...args);
    });
    await f.session.soloPreferences.removeSection("work");
    await vi.waitFor(() => expect(hashing).toBe(true));
    void f.clearCache();
    release();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(written(f).map(({ value }) => value.type)).toEqual(["groups"]);
  } finally {
    release();
    f.dispose();
  }
});

it.each([
  ["has no saved settings", false],
  ["already has deleted settings", true],
] as const)(
  "writes only the groups record when the workspace %s",
  async (_case, deleted) => {
    const f = fixture();
    try {
      f.install(workspaces);
      if (deleted) f.install(await settings("work"), true);
      await f.session.soloPreferences.ensure();
      await f.session.soloPreferences.removeSection("work");
      // A later queued mutation runs after any cleanup the removal queued.
      await f.session.soloPreferences.removeSection("work");
      expect(written(f).map(({ value }) => value.type)).toEqual(["groups"]);
    } finally {
      f.dispose();
    }
  },
);

it("keeps a workspace deleted when its settings can't be deleted", async () => {
  const f = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const saved = await settings("work");
    f.install(workspaces);
    f.install(saved);
    f.prepare.mockImplementation(async (record) => {
      if (record.value.type === "template") throw new Error("Signer offline");
      return JSON.stringify(record);
    });
    await f.session.soloPreferences.ensure();
    await expect(
      f.session.soloPreferences.removeSection("work"),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(String(warn.mock.calls[0]?.[1])).toContain("Signer offline");
    expect(f.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deleted: true,
        value: expect.objectContaining({ id: saved.id }),
      }),
      expect.anything(),
    );
    expect(written(f).map(({ value }) => value.type)).toEqual(["groups"]);
    await f.session.soloPreferences.refresh();
    expect(
      f.session.soloPreferences.snapshot().data?.sections.map(({ id }) => id),
    ).toEqual(["keep"]);
  } finally {
    f.dispose();
  }
});

it("writes no tombstone when the groups write fails", async () => {
  const f = fixture();
  try {
    f.install(workspaces);
    f.install(await settings("work"));
    f.prepare.mockRejectedValueOnce(new Error("Signer offline"));
    await f.session.soloPreferences.ensure();
    await expect(
      f.session.soloPreferences.removeSection("work"),
    ).rejects.toThrow("Signer offline");
    // A later queued mutation runs after any cleanup the removal queued.
    await f.session.soloPreferences.removeSection("missing");
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.publish).not.toHaveBeenCalled();
    expect(
      f.session.soloPreferences.snapshot().data?.sections.map(({ id }) => id),
    ).toEqual(["work", "keep"]);
  } finally {
    f.dispose();
  }
});

const lead = { region: "buzz.region:nexus:tasks", channelId: channel };
const leadsRecord = (
  leads: Record<string, Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) =>
  ({
    version: 1,
    community,
    deleted: false,
    value: { type: "workspace-leads", id: "me", leads, ...extra },
  }) as PrivateRecord;
const tagged = (f: ReturnType<typeof fixture>, tag: string) =>
  f.publish.mock.calls
    .map(([event]) => event)
    .filter((event) => event.tags.some((t) => t[0] === "t" && t[1] === tag))
    .map((event) => JSON.parse(event.content));

it("keeps Leads in their own record, fencing conflicting replacements and leaving Groups at main's fields", async () => {
  const f = fixture();
  const preferences = f.session.soloPreferences;
  try {
    f.install(groups);
    await preferences.refresh();
    await preferences.setWorkspaceLead(
      { workspaceId: "work", lead },
      new AbortController().signal,
    );
    expect(preferences.leads.snapshot()).toEqual({
      status: "ready",
      leads: { work: lead },
    });
    const [saved] = tagged(f, LEADS_TAG);
    expect(saved).toEqual(leadsRecord({ work: lead }));
    expect(
      f.publish.mock.calls[0]?.[0].tags.find((t) => t[0] === "d")?.[1],
    ).toBe(leadsCoordinate(community));
    // The catalog never fetches the Leads record; older clients cannot either.
    await f.session.channelKit.refresh();
    expect(
      f.query.mock.calls.some(([filters]) =>
        filters.some((filter) => filter["#t"]?.includes(LEADS_TAG)),
      ),
    ).toBe(false);
    const writes = f.publish.mock.calls.length;
    await preferences.setWorkspaceLead(
      { workspaceId: "work", lead },
      new AbortController().signal,
    );
    expect(f.publish).toHaveBeenCalledTimes(writes);
    for (const expected of [undefined, "stale"])
      await expect(
        preferences.setWorkspaceLead(
          {
            workspaceId: "work",
            lead: { ...lead, channelId: other },
            ...(expected ? { expected } : {}),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("already has a lead");
    expect(f.publish).toHaveBeenCalledTimes(writes);
    expect(
      await preferences.setWorkspaceLead(
        { workspaceId: "missing", lead },
        new AbortController().signal,
      ),
    ).toBe(false);
    await preferences.setWorkspaceLead(
      {
        workspaceId: "work",
        lead: { ...lead, channelId: other },
        expected: channel,
      },
      new AbortController().signal,
    );
    expect(preferences.leads.snapshot().leads.work?.channelId).toBe(other);
    await preferences.assign(other, undefined);
    await preferences.createSection({ id: "next", name: "Next" });
    // Every Groups record this change emits keeps main's strict workspace
    // fields; the shared corpus runs the same shape through native admission.
    const emitted = tagged(f, ME_KIT_TAG);
    expect(emitted.length).toBeGreaterThan(1);
    for (const record of emitted)
      for (const group of record.value.groups)
        expect(Object.keys(group).sort()).toEqual([
          "defaultTemplateId",
          "id",
          "name",
        ]);
    const oracle = leadCases.find((item) =>
      item.name.startsWith("groups emitted beside leads"),
    );
    expect(oracle?.accepted).toBe(true);
    expect(Object.keys(oracle?.record.value.groups?.[0] ?? {}).sort()).toEqual([
      "defaultTemplateId",
      "id",
      "name",
    ]);
  } finally {
    f.dispose();
  }
});

it("keeps unknown Leads fields, hides and prunes orphans, and best-effort removes a deleted workspace's Lead", async () => {
  const f = fixture();
  const preferences = f.session.soloPreferences;
  try {
    f.install({
      ...groups,
      groups: [
        ...groups.groups,
        { id: "next", name: "Next", defaultTemplateId: "" },
      ],
    });
    f.installRecord(
      leadsRecord(
        {
          work: { ...lead, pinnedAt: 1 },
          gone: lead,
        },
        { future: { kept: true } },
      ),
    );
    await preferences.refresh();
    await f.session.soloPreferences.leads.refresh();
    await preferences.setWorkspaceLead(
      { workspaceId: "next", lead: { ...lead, channelId: other } },
      new AbortController().signal,
    );
    expect(tagged(f, LEADS_TAG).at(-1)).toEqual(
      leadsRecord(
        {
          work: { ...lead, pinnedAt: 1 },
          next: { ...lead, channelId: other },
        },
        { future: { kept: true } },
      ),
    );
    // A replacement keeps the fields of the entry it replaces.
    await preferences.setWorkspaceLead(
      {
        workspaceId: "work",
        lead: { ...lead, channelId: other },
        expected: channel,
      },
      new AbortController().signal,
    );
    expect(tagged(f, LEADS_TAG).at(-1)?.value.leads.work).toEqual({
      ...lead,
      channelId: other,
      pinnedAt: 1,
    });
    await preferences.removeSection("work");
    await vi.waitFor(() =>
      expect(tagged(f, LEADS_TAG).at(-1)?.value.leads).toEqual({
        next: { ...lead, channelId: other },
      }),
    );
    expect(tagged(f, LEADS_TAG).at(-1)?.value.future).toEqual({ kept: true });
    // A failed cleanup read keeps the Lead and never fails the deletion.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const writes = f.publish.mock.calls.length;
    f.leadReads.fail = new Error("Leads read failed");
    await preferences.removeSection("next");
    expect(preferences.snapshot().data?.sections.map(({ id }) => id)).toEqual(
      [],
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(f.publish).toHaveBeenCalledTimes(writes + 1);
    expect(tagged(f, LEADS_TAG).at(-1)?.value.leads).toHaveProperty("next");
  } finally {
    f.dispose();
  }
});

it("isolates an unreadable Leads record from workspaces and the catalog, and never writes over it", async () => {
  const f = fixture();
  const preferences = f.session.soloPreferences;
  try {
    f.install(groups);
    f.installRecord(leadsRecord({ work: { ...lead, channelId: "invalid" } }));
    await preferences.refresh();
    await preferences.leads.refresh();
    expect(preferences.leads.snapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("Invalid workspace lead"),
    });
    expect(f.session.channelKit.snapshot().status).toBe("ready");
    expect(preferences.snapshot().status).toBe("ready");
    await expect(
      preferences.setWorkspaceLead(
        { workspaceId: "work", lead },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Invalid workspace lead");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await preferences.createSection({ id: "next", name: "Next" });
    await preferences.removeSection("work");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(tagged(f, LEADS_TAG)).toEqual([]);
    // A readable record recovers on the next read.
    f.installRecord(leadsRecord({ next: lead }));
    await preferences.leads.refresh();
    expect(preferences.leads.snapshot()).toEqual({
      status: "ready",
      leads: { next: lead },
    });
  } finally {
    f.dispose();
  }
});

it("loads Leads beside Groups, and session recovery retries a transient failure", async () => {
  const f = fixture();
  const preferences = f.session.soloPreferences;
  try {
    f.install(groups);
    f.installRecord(leadsRecord({ work: lead }));
    f.leadReads.fail = new TypeError("Failed to fetch");
    // Nothing asks for Leads: the ready catalog starts their read.
    await preferences.refresh();
    await vi.waitFor(() =>
      expect(preferences.leads.snapshot()).toMatchObject({
        status: "error",
        transient: true,
      }),
    );
    expect(preferences.snapshot().status).toBe("ready");
    expect(f.session.recovery?.snapshot().recovering).toBe(true);
    f.leadReads.fail = false;
    f.session.recovery?.retryNow();
    await vi.waitFor(() =>
      expect(preferences.leads.snapshot()).toEqual({
        status: "ready",
        leads: { work: lead },
      }),
    );
    await vi.waitFor(() =>
      expect(f.session.recovery?.snapshot().recovering).toBe(false),
    );
    // A cleared session reads them again with the next catalog.
    await f.clearCache();
    expect(preferences.leads.snapshot().status).not.toBe("ready");
    await preferences.refresh();
    await vi.waitFor(() =>
      expect(preferences.leads.snapshot()).toEqual({
        status: "ready",
        leads: { work: lead },
      }),
    );
  } finally {
    f.dispose();
  }
});

it("prunes Leads against Groups read after them, so another device's Lead survives", async () => {
  const f = fixture();
  const preferences = f.session.soloPreferences;
  const next = { ...lead, channelId: other };
  // Another device adds a workspace and saves its Lead; the record contract
  // lets that writer keep orphans, here the Lead of the deleted workspace.
  const theirs = (work: boolean) => () => {
    // Newer than this device's own writes.
    const at = Math.floor(Date.now() / 1000);
    f.install(
      {
        type: "groups",
        id: "me",
        groups: [
          ...(work ? groups.groups : []),
          { id: "theirs", name: "Theirs", defaultTemplateId: "" },
        ],
        assignments: {},
      },
      false,
      at,
    );
    f.installRecord(leadsRecord({ work: lead, theirs: lead }), at);
  };
  try {
    f.install(groups);
    f.installRecord(leadsRecord({ work: lead }));
    await preferences.refresh();
    await preferences.leads.refresh();
    // Between the deletion's Groups save and its cleanup.
    f.leadReads.before = theirs(false);
    await preferences.removeSection("work");
    await vi.waitFor(() => expect(tagged(f, LEADS_TAG)).toHaveLength(1));
    expect(tagged(f, LEADS_TAG)[0]?.value.leads).toEqual({ theirs: lead });

    // Between the setter's reads.
    f.install(groups);
    f.installRecord(leadsRecord({ work: lead }));
    f.leadReads.before = theirs(true);
    await preferences.setWorkspaceLead(
      { workspaceId: "work", lead: next, expected: channel },
      new AbortController().signal,
    );
    expect(tagged(f, LEADS_TAG).at(-1)?.value.leads).toEqual({
      work: next,
      theirs: lead,
    });
  } finally {
    f.dispose();
  }
});

it("never lets a refresh begun before a confirmed Lead write show the older Leads", async () => {
  const f = fixture();
  const preferences = f.session.soloPreferences;
  try {
    f.install(groups);
    await preferences.refresh();
    await vi.waitFor(() =>
      expect(preferences.leads.snapshot().status).toBe("ready"),
    );
    let release = () => {};
    f.leadReads.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = preferences.leads.refresh();
    try {
      await vi.waitFor(() => expect(f.leadReads.hold).toBeUndefined());
      await preferences.setWorkspaceLead(
        { workspaceId: "work", lead },
        new AbortController().signal,
      );
      expect(preferences.leads.snapshot().leads).toEqual({ work: lead });
    } finally {
      release();
    }
    await stale;
    expect(preferences.leads.snapshot()).toEqual({
      status: "ready",
      leads: { work: lead },
    });
  } finally {
    f.dispose();
  }
});
