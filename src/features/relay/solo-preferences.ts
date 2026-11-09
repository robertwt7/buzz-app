import type { ChannelKit } from "../channel-templates/capability";
import {
  emptyLineup,
  kitRecordFits,
  leadsCoordinate,
  parseLeadsRecord,
  soloCapacityMessage,
  type Groups,
  type KitEntry,
  type LeadsRecord,
  type WorkspaceLead,
} from "../channel-templates/model";
import { projectTemplateId, templateEntry } from "../solo/workspace";
import { isTransientFailure } from "./errors";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarAssignmentIntent,
  SidebarGroups,
} from "./sidebar-preferences";

export function soloGroups(entries: readonly KitEntry[]) {
  return entries.find(
    (entry) =>
      entry.record.value.type === "groups" && entry.record.value.id === "me",
  );
}
function project(groups: Groups): SidebarGroups {
  return {
    sections: groups.groups.map(({ id, name }, order) => ({
      id,
      name,
      order,
    })),
    assignments: groups.assignments,
  };
}
const empty = (): Groups => ({
  type: "groups",
  id: "me",
  groups: [],
  assignments: {},
});

// Object key order changes through native JSON maps. Only group order is
// presentation data; assignment insertion order is not.
function comparable(value: Groups) {
  return JSON.stringify([
    value.id,
    value.groups.map(({ id, name, defaultTemplateId }) => [
      id,
      name,
      defaultTemplateId,
    ]),
    Object.entries(value.assignments).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

function admit(value: Groups, entry: KitEntry | undefined) {
  // With no saved record, any filing fits. Existing records retain their
  // exact community envelope, including its UTF-8 byte cost.
  if (entry && !kitRecordFits({ ...entry.record, deleted: false, value }))
    throw new Error(soloCapacityMessage);
}

export const leadUnavailableMessage =
  "Lead unavailable. Check your connection and try again.";
export type LeadsSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  /** Saved entries, orphans included; readers join them to workspaces. */
  leads: Readonly<Record<string, WorkspaceLead>>;
  error?: string;
  /** Session recovery retries only failures a retry can fix. */
  transient?: true;
}>;
type LeadsHead = {
  record: LeadsRecord | undefined;
  eventId: string | undefined;
};

/** Reuse recipe revision checks/outbox and preference lifecycle; never read Messages groups. */
export function createSoloPreferences(kit: ChannelKit, lifetime: AbortSignal) {
  let mutations = Promise.resolve();
  let generation = new AbortController();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const admitted = generation.signal;
    const next = mutations.then(() => {
      admitted.throwIfAborted();
      lifetime.throwIfAborted();
      return operation();
    });
    mutations = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  // Leads are a separate record: a failed or malformed read never touches Groups.
  let leads: LeadsSnapshot = { status: "idle", leads: {} };
  let leadsRead: Promise<void> | undefined;
  // Each shown head bumps this; a refresh begun before it is stale.
  let leadsRevision = 0;
  const leadListeners = new Set<() => void>();
  const publishLeads = (next: LeadsSnapshot) => {
    leads = next;
    leadListeners.forEach((listener) => {
      listener();
    });
  };
  const showLeads = (head: LeadsHead) => {
    leadsRevision++;
    publishLeads({
      status: "ready",
      leads: Object.fromEntries(
        Object.entries(
          head.record && !head.record.deleted ? head.record.value.leads : {},
        ).map(([id, { region, channelId }]) => [id, { region, channelId }]),
      ),
    });
  };
  async function readLeads(active: AbortSignal): Promise<LeadsHead> {
    const found = await kit.readRecord(leadsCoordinate(kit.community), active);
    active.throwIfAborted();
    return {
      record: found && parseLeadsRecord(found.record, kit.community),
      eventId: found?.eventId,
    };
  }
  function refreshLeads() {
    if (leadsRead) return leadsRead;
    const active = AbortSignal.any([lifetime, generation.signal]);
    const revision = leadsRevision;
    if (leads.status !== "ready")
      publishLeads({ status: "loading", leads: leads.leads });
    const read: Promise<void> = readLeads(active)
      .then(
        (head) => {
          if (leadsRevision === revision) showLeads(head);
        },
        (error: unknown) => {
          if (!active.aborted && leadsRevision === revision)
            publishLeads({
              status: "error",
              leads: leads.leads,
              error: String(error),
              ...(isTransientFailure(error)
                ? { transient: true as const }
                : {}),
            });
        },
      )
      .finally(() => {
        if (leadsRead === read) leadsRead = undefined;
      });
    leadsRead = read;
    return read;
  }
  // Leads load beside Groups once the catalog is ready, and again after clear().
  const stopLeads = kit.subscribe(() => {
    if (leads.status === "idle" && kit.snapshot().status === "ready")
      void refreshLeads();
  });
  /** Write `changes` over the fresh head, pruning Leads of removed workspaces.
   * Unknown record and entry fields are kept. */
  async function writeLeads(
    head: LeadsHead,
    groups: Groups,
    changes: Readonly<Record<string, WorkspaceLead | undefined>>,
    active: AbortSignal,
  ) {
    const workspaces = new Set(groups.groups.map(({ id }) => id));
    const saved =
      head.record && !head.record.deleted ? head.record.value.leads : {};
    const next = Object.fromEntries(
      Object.entries(saved).filter(
        ([id]) => workspaces.has(id) && !Object.hasOwn(changes, id),
      ),
    );
    for (const [id, lead] of Object.entries(changes))
      if (lead && workspaces.has(id))
        next[id] = { ...(Object.hasOwn(saved, id) ? saved[id] : {}), ...lead };
    const record = parseLeadsRecord(
      {
        version: 1,
        community: kit.community,
        deleted: false,
        value: {
          ...(head.record?.value ?? { type: "workspace-leads", id: "me" }),
          leads: next,
        },
      },
      kit.community,
    );
    // The writer confirms this exact event is the selected head.
    const eventId = await kit.saveRecord(record, head.eventId, active);
    active.throwIfAborted();
    showLeads({ record, eventId });
  }
  async function current(signal = lifetime, fresh = true) {
    const active = AbortSignal.any([lifetime, generation.signal, signal]);
    active.throwIfAborted();
    if (fresh || kit.snapshot().status !== "ready") await kit.refresh();
    active.throwIfAborted();
    const state = kit.snapshot();
    if (state.status !== "ready")
      throw new Error(state.error ?? "Solo groups are unavailable");
    const entry = soloGroups(state.entries);
    return {
      entry,
      value:
        entry && !entry.record.deleted && entry.record.value.type === "groups"
          ? entry.record.value
          : empty(),
      active,
    };
  }
  async function save(
    value: Groups,
    entry: KitEntry | undefined,
    active: AbortSignal,
  ) {
    admit(value, entry);
    await kit.save(value, entry?.eventId, false, active);
    active.throwIfAborted();
    const confirmed = soloGroups(kit.snapshot().entries);
    if (
      !confirmed ||
      confirmed.record.deleted ||
      confirmed.record.value.type !== "groups" ||
      comparable(confirmed.record.value) !== comparable(value)
    )
      throw new Error("Solo group changes could not be confirmed");
    return project(value);
  }
  const store = createSidebarPreferencesStore({
    read: async (signal) => ({
      ...project((await current(signal, false)).value),
      starred: [],
      muted: [],
    }),
    available: kit.available,
    write: (intent: SidebarAssignmentIntent, signal) =>
      serialize(async () => {
        const { value, entry, active } = await current(signal);
        const target = intent.createSection?.id ?? intent.sectionId;
        let groups = value.groups;
        if (intent.createSection) {
          const name = intent.createSection.name.trim();
          const existing = groups.find((group) => group.id === target);
          if (existing && existing.name !== name)
            throw new Error(
              "The new Solo group changed; refresh before retrying",
            );
          if (!existing)
            groups = [
              ...groups,
              { id: intent.createSection.id, name, defaultTemplateId: "" },
            ];
        }
        if (target && !groups.some((group) => group.id === target))
          throw new Error("The Solo group is unavailable");
        const assignments = { ...value.assignments };
        if (intent.channelId !== undefined) {
          if (target) assignments[intent.channelId] = target;
          else delete assignments[intent.channelId];
        }
        if (
          groups === value.groups &&
          (intent.channelId === undefined ||
            value.assignments[intent.channelId] === target)
        )
          return project(value);
        return save({ ...value, groups, assignments }, entry, active);
      }),
    removeSection: (id, signal) =>
      serialize(async () => {
        const { value, entry, active } = await current(signal);
        const groups = {
          ...value,
          groups: value.groups.filter((group) => group.id !== id),
          assignments: Object.fromEntries(
            Object.entries(value.assignments).filter(
              ([, group]) => group !== id,
            ),
          ),
        };
        const saved = value.groups.some((group) => group.id === id)
          ? await save(groups, entry, active)
          : project(value);
        // Best effort, once the workspace is gone: delete its settings (name,
        // instructions, folders, agents). A record left behind is unreachable.
        // An already-absent workspace gets this too: a groups write can land
        // after failing to confirm, and its retry finds the workspace gone.
        void serialize(async () => {
          const cleanup = AbortSignal.any([lifetime, generation.signal]);
          const settings = templateEntry(
            kit.snapshot().entries,
            await projectTemplateId(id),
          );
          if (settings?.record.value.type === "template")
            await kit.save(
              {
                ...settings.record.value,
                ...emptyLineup(),
                name: "Deleted workspace",
              },
              settings.eventId,
              true,
              cleanup,
            );
        }).catch((error: unknown) => {
          console.warn("The deleted workspace's settings were kept", error);
        });
        // Best effort: a Lead left behind is hidden and pruned on the next write.
        // Another writer may keep this orphan beside a newer workspace's Lead:
        // prune against Groups read after the Leads, not the ones captured here.
        // An ended session drops it silently; the next Leads write prunes it.
        const leadCleanup = AbortSignal.any([lifetime, generation.signal]);
        void serialize(async () => {
          const head = await readLeads(leadCleanup);
          const leads = head.record?.deleted ? {} : head.record?.value.leads;
          if (!leads || !Object.hasOwn(leads, id)) return;
          const { value } = await current(leadCleanup);
          if (!value.groups.some((group) => group.id === id))
            await writeLeads(head, value, {}, leadCleanup);
        }).catch((error: unknown) => {
          if (!leadCleanup.aborted)
            console.warn("The deleted workspace's Lead was kept", error);
        });
        return saved;
      }),
    groupsOnly: true,
    createSection: (section, signal) =>
      serialize(async () => {
        const { value, entry, active } = await current(signal);
        const name = section.name.trim();
        const existing = value.groups.find((group) => group.id === section.id);
        if (existing) {
          if (existing.name !== name)
            throw new Error(
              "The new Solo workspace changed; refresh before retrying",
            );
          return project(value);
        }
        return save(
          {
            ...value,
            groups: [
              ...value.groups,
              { id: section.id, name, defaultTemplateId: "" },
            ],
          },
          entry,
          active,
        );
      }),
  });
  return {
    ...store,
    // Preserve the preference owner’s live writable getters.
    queries: Object.freeze(
      Object.assign(
        Object.defineProperties(
          {},
          Object.getOwnPropertyDescriptors(store.queries),
        ) as typeof store.queries,
        {
          leads: Object.freeze({
            snapshot: () => leads,
            subscribe(listener: () => void) {
              leadListeners.add(listener);
              return () => {
                leadListeners.delete(listener);
              };
            },
            refresh: refreshLeads,
          }),
          setWorkspaceLead: (
            input: {
              workspaceId: string;
              lead: WorkspaceLead;
              expected?: string;
            },
            signal: AbortSignal,
          ) =>
            serialize(async () => {
              // Leads first: a Lead is saved only after its workspace, so
              // Groups read after it hold every workspace the Leads name.
              const head = await readLeads(
                AbortSignal.any([lifetime, generation.signal, signal]),
              );
              const { value, active } = await current(signal);
              showLeads(head);
              if (!value.groups.some(({ id }) => id === input.workspaceId))
                return false;
              const saved =
                head.record && !head.record.deleted
                  ? head.record.value.leads[input.workspaceId]
                  : undefined;
              if (
                saved?.region === input.lead.region &&
                saved.channelId === input.lead.channelId
              )
                return true;
              if (saved && saved.channelId !== input.expected)
                throw new Error(
                  "This workspace already has a lead. Open it from the workspace title; your draft is kept.",
                );
              await writeLeads(
                head,
                value,
                { [input.workspaceId]: input.lead },
                active,
              );
              return true;
            }),
        },
      ),
    ),
    clear() {
      generation.abort();
      generation = new AbortController();
      leadsRead = undefined;
      publishLeads({ status: "idle", leads: {} });
      store.clear();
    },
    dispose() {
      generation.abort();
      stopLeads();
      store.dispose();
    },
  };
}
