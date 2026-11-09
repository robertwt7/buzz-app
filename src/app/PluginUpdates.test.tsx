// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { PluginUpdates, PluginUpdatesMenu } from "./PluginUpdates";
import { PluginMenu } from "./PluginMenu";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../shared/design-system/ui/Menu";
import type { PluginManager } from "../plugins/manager";
import type { ImportPreview, PluginInfo } from "../plugins/types";
import type { AppServices } from "./services";
import { createPluginInstallRequests } from "../plugins/installer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fixture() {
  const source = {
    repository: "https://example.com/plugins.git",
    reference: "main",
    path: ".",
  };
  const plugin: PluginInfo = {
    manifest: {
      id: "example.notes",
      name: "Notes",
      apiVersion: 1,
      updates: { defaultEnabled: true },
    },
    source: "external",
    enabled: true,
    revision: "old",
    previous: "older",
    reloadable: true,
    error: null,
    updateSource: source,
  };
  const candidate = {
    path: ".",
    manifest: plugin.manifest,
    revision: "new",
    publisher: null as string | null,
  };
  const freshCandidate = { ...candidate };
  const discovered: ImportPreview = {
    token: "metadata",
    source: source.repository,
    commit: "a".repeat(40),
    candidates: [candidate],
    warnings: [],
  };
  const fresh: ImportPreview = {
    ...discovered,
    token: "immutable-preview",
    candidates: [freshCandidate],
  };
  let snapshot: ReturnType<PluginManager["snapshot"]> = {
    configuration: {
      status: "ready" as const,
      externalPluginsPaused: false,
      catalog: { profile: "test", location: "test", plugins: [plugin] },
    },
    busy: false,
    activation: {},
    error: null,
    refreshError: null,
  };
  const listeners = new Set<() => void>();
  const imports = {
    checkGit: vi.fn(async () => discovered),
    git: vi.fn(async () => fresh),
    discard: vi.fn(async () => {}),
  };
  const installImport = vi.fn(async () => true);
  const manager = {
    imports,
    installImport,
    change: vi.fn(),
    retryPlugin: vi.fn(),
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as PluginManager;
  const navigation = {
    open: vi.fn(async () => ({ status: "opened" as const })),
  };
  const installRequests = createPluginInstallRequests();
  const relay = { snapshot: () => ({ session: {} }) } as AppServices["relay"];
  const mount = () =>
    render(
      <ToastProvider>
        <PluginUpdates
          plugins={manager}
          navigation={navigation}
          relay={relay}
          installRequests={installRequests}
        >
          <MenuRoot>
            <MenuTrigger>Profile</MenuTrigger>
            <MenuPopup>
              <PluginUpdatesMenu recommendations={0} onManage={vi.fn()} />
            </MenuPopup>
          </MenuRoot>
        </PluginUpdates>
      </ToastProvider>,
    );
  return {
    source,
    candidate,
    freshCandidate,
    plugin,
    discovered,
    fresh,
    imports,
    installImport,
    navigation,
    installRequests,
    manager,
    state: () => snapshot,
    emit(next: Partial<ReturnType<PluginManager["snapshot"]>>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
    mount,
  };
}

it("checks one hour after configuration becomes ready", async () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const f = fixture();
  const ready = f.state().configuration;
  f.candidate.revision = f.plugin.revision;
  f.emit({ configuration: { status: "loading" } });
  const view = f.mount();
  try {
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => f.emit({ configuration: ready }));
    expect(f.imports.checkGit).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(3_599_999));
    expect(f.imports.checkGit).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(f.imports.checkGit).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    visibility.mockRestore();
  }
});

it("stops scheduling during configuration recovery after pending discovery", async () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const f = fixture();
  const ready = f.state().configuration;
  f.candidate.revision = f.plugin.revision;
  let finish!: (preview: ImportPreview) => void;
  f.imports.checkGit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const snapshot = vi.spyOn(f.manager, "snapshot");
  const view = f.mount();
  try {
    await act(async () => {});
    expect(f.imports.checkGit).toHaveBeenCalledTimes(1);
    await act(async () => f.emit({ configuration: { status: "loading" } }));
    await act(() => vi.advanceTimersByTimeAsync(3_600_000));
    await act(async () => finish(f.discovered));
    const reads = snapshot.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(snapshot).toHaveBeenCalledTimes(reads);
    await act(async () => f.emit({ configuration: ready }));
    expect(f.imports.checkGit).toHaveBeenCalledTimes(2);
  } finally {
    finish(f.discovered);
    view.unmount();
    visibility.mockRestore();
    snapshot.mockRestore();
  }
});

it.each([true, false])(
  "lets the user override the plugin's default check policy (%s)",
  async (defaultEnabled) => {
    const f = fixture();
    f.plugin.manifest = { ...f.plugin.manifest, updates: { defaultEnabled } };
    render(<PluginMenu plugin={f.plugin} plugins={f.manager} busy={false} />);
    fireEvent.click(
      screen.getByRole("button", { name: "More plugin actions" }),
    );
    const choice = await screen.findByRole("menuitemcheckbox", {
      name: "Check for updates automatically",
    });
    expect(choice).toHaveAttribute("aria-checked", String(defaultEnabled));
    fireEvent.click(choice);
    expect(f.manager.change).toHaveBeenCalledWith(
      defaultEnabled ? "disable-update-checks" : "enable-update-checks",
      f.plugin.manifest.id,
    );
  },
);

it("removes a pending update action when the user turns off checks", async () => {
  const f = fixture();
  let finish!: (preview: ImportPreview) => void;
  f.imports.git.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() => expect(f.imports.git).toHaveBeenCalled());
  act(() => {
    f.plugin.updateChecks = false;
    f.emit({});
  });
  await act(async () => {
    finish(f.fresh);
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Update and reload" }),
    ).not.toBeInTheDocument(),
  );
  expect(f.installImport).not.toHaveBeenCalled();
});

it("opens the plugin's update settings from the notice body", async () => {
  const f = fixture();
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage Notes update checks" }),
  );
  expect(f.navigation.open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "plugins",
    pluginId: "example.notes",
  });
  expect(f.installImport).not.toHaveBeenCalled();
});

it("requires explicit update confirmation before showing installation progress", async () => {
  const f = fixture();
  f.freshCandidate.revision = "newer";
  f.candidate.revision = "newer";
  let finish!: (success: boolean) => void;
  f.installImport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  const review = await screen.findByRole("dialog", { name: "Update Notes" });
  const confirm = within(review).getByRole("button", { name: "Update" });
  expect(f.installImport).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(f.installImport).toHaveBeenCalledExactlyOnceWith(
      "immutable-preview",
      ".",
    ),
  );
  try {
    const dialog = screen.getByRole("dialog", { name: "Update Notes" });
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Updating plugin",
    );
    expect(
      within(dialog).getByRole("button", { name: "Update" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("region", { name: "Computer access" }),
    ).toBeVisible();
    expect(screen.queryByRole("region", { name: "Plugin updates" })).toBeNull();
  } finally {
    await act(async () => {
      finish(true);
    });
  }
  await waitFor(() => expect(screen.queryByText("Updating plugin")).toBeNull());
  expect(f.imports.git).toHaveBeenCalledOnce();
  expect(f.manager.change).not.toHaveBeenCalled();
});

it("routes a caller's fresh update queue through the existing confirmation dialog", async () => {
  const f = fixture();
  f.freshCandidate.revision = "newer";
  f.candidate.revision = "newer";
  let finish!: (success: boolean) => void;
  f.installImport.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.mount();
  await screen.findByRole("button", { name: "Update and reload" });
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");

  let queue: ReturnType<typeof capability.queueUpdates>;
  act(() => {
    queue = capability.queueUpdates([token]);
  });
  if (!queue) throw new Error("Expected the host to accept a fresh queue");
  const queueId = queue.id;
  const review = await screen.findByRole("dialog", { name: "Update Notes" });
  expect(f.installImport).not.toHaveBeenCalled();
  fireEvent.click(within(review).getByRole("button", { name: "Update" }));

  await waitFor(() =>
    expect(f.installImport).toHaveBeenCalledExactlyOnceWith(
      "immutable-preview",
      ".",
    ),
  );
  expect(capability.getQueue(queueId)?.items[0]?.status).toBe("reviewing");
  await act(async () => finish(true));
  await waitFor(() =>
    expect(capability.getQueue(queueId)?.items[0]?.status).toBe("installed"),
  );
  expect(capability.getQueue(queueId)?.status).toBe("completed");
});

it("does not install when a queued review is cancelled before its confirmation handler runs", async () => {
  const f = fixture();
  f.freshCandidate.revision = "newer";
  f.candidate.revision = "newer";
  f.mount();
  await screen.findByRole("button", { name: "Update and reload" });
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");
  let queue: ReturnType<typeof capability.queueUpdates>;
  act(() => {
    queue = capability.queueUpdates([token]);
  });
  const accepted = queue;
  if (!accepted) throw new Error("Expected the host to accept a fresh queue");

  const review = await screen.findByRole("dialog", { name: "Update Notes" });
  const confirm = within(review).getByRole("button", { name: "Update" });
  act(() => {
    expect(capability.cancelQueue(accepted.id)).toBe(true);
    fireEvent.click(confirm);
  });

  expect(f.installImport).not.toHaveBeenCalled();
  expect(capability.getQueue(accepted.id)).toMatchObject({
    status: "cancelled",
    items: [{ status: "cancelled" }],
  });
  expect(screen.queryByRole("dialog", { name: "Update Notes" })).toBeNull();
});

it("retains an accepted update review when the Marketplace consumer unmounts", async () => {
  const f = fixture();
  const relay = { snapshot: () => ({ session: {} }) } as AppServices["relay"];
  const host = (children: ReactNode) => (
    <PluginUpdates
      plugins={f.manager}
      navigation={f.navigation}
      relay={relay}
      installRequests={f.installRequests}
    >
      {children}
    </PluginUpdates>
  );
  const view = render(host(<div>Marketplace</div>));
  await waitFor(() =>
    expect(f.installRequests.updates?.getSnapshot().status).toBe("fresh"),
  );
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");
  let queue: ReturnType<typeof capability.queueUpdates>;
  act(() => {
    queue = capability.queueUpdates([token]);
  });
  if (!queue) throw new Error("Expected the host to accept a fresh queue");
  const queueId = queue.id;

  await screen.findByRole("dialog", { name: "Update Notes" });
  view.rerender(host(null));

  expect(capability.getQueue(queueId)?.items[0]?.status).toBe("reviewing");
  const review = screen.getByRole("dialog", { name: "Update Notes" });
  fireEvent.click(within(review).getByRole("button", { name: "Update" }));
  await waitFor(() => expect(f.installImport).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(capability.getQueue(queueId)?.items[0]?.status).toBe("installed"),
  );
});

it("refreshes instead of opening a stale retained update", async () => {
  const f = fixture();
  f.mount();
  const update = await screen.findByRole("button", {
    name: "Update and reload",
  });
  await waitFor(() =>
    expect(f.installRequests.updates?.getSnapshot().status).toBe("fresh"),
  );

  f.plugin.revision = "changed before review";
  fireEvent.click(update);

  await waitFor(() => expect(f.imports.checkGit).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Update Notes" }),
  ).toBeVisible();
});

it("opens a known update when an unrelated plugin check fails", async () => {
  const f = fixture();
  const configuration = f.state().configuration;
  if (configuration.status !== "ready") throw new Error("Expected catalog");
  const other: PluginInfo = {
    ...f.plugin,
    manifest: { ...f.plugin.manifest, id: "example.other", name: "Other" },
    updateSource: {
      ...f.source,
      repository: "https://example.com/other.git",
      path: "other",
    },
  };
  f.emit({
    configuration: {
      ...configuration,
      catalog: { ...configuration.catalog, plugins: [f.plugin, other] },
    },
  });
  f.imports.checkGit
    .mockResolvedValueOnce(f.discovered)
    .mockRejectedValueOnce(new Error("Other repository is unavailable."));
  f.mount();

  const capability = f.installRequests.updates;
  await waitFor(() => expect(capability?.getSnapshot().status).toBe("error"));
  const snapshot = capability?.getSnapshot();
  const token = snapshot?.candidates.find(
    (candidate) => candidate.id === f.plugin.manifest.id,
  )?.token;
  expect(snapshot?.errors).toEqual([
    { id: other.manifest.id, message: "Other repository is unavailable." },
  ]);
  if (!token) throw new Error("Expected the unaffected update token");

  fireEvent.click(screen.getByRole("button", { name: "Update and reload" }));

  expect(
    await screen.findByRole("dialog", { name: "Update Notes" }),
  ).toBeVisible();
  expect(f.installImport).not.toHaveBeenCalled();
});

it("refuses a queued update when the installed revision changes after review opens", async () => {
  const f = fixture();
  f.freshCandidate.revision = "newer";
  f.candidate.revision = "newer";
  f.mount();
  await screen.findByRole("button", { name: "Update and reload" });
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");

  let queue: ReturnType<typeof capability.queueUpdates>;
  act(() => {
    queue = capability.queueUpdates([token]);
  });
  if (!queue) throw new Error("Expected the host to accept a fresh queue");
  const queueId = queue.id;
  const review = await screen.findByRole("dialog", { name: "Update Notes" });
  f.plugin.revision = "changed while the review was open";
  fireEvent.click(within(review).getByRole("button", { name: "Update" }));

  expect(
    await within(review).findByText(
      "The update candidate changed after it was checked. Check for updates again before reviewing it.",
    ),
  ).toBeVisible();
  expect(capability.getQueue(queueId)?.items[0]?.status).toBe("reviewing");
  expect(f.installImport).not.toHaveBeenCalled();
  fireEvent.click(within(review).getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(capability.getQueue(queueId)?.items[0]?.status).toBe("failed"),
  );
});

it("keeps a stale queued review mounted to show its confirmation refusal", async () => {
  const f = fixture();
  f.mount();
  await screen.findByRole("button", { name: "Update and reload" });
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");

  let queue: ReturnType<typeof capability.queueUpdates>;
  act(() => {
    queue = capability.queueUpdates([token]);
  });
  const accepted = queue;
  if (!accepted) throw new Error("Expected an accepted fresh queue");
  const review = await screen.findByRole("dialog", { name: "Update Notes" });

  f.imports.checkGit.mockResolvedValueOnce({
    ...f.discovered,
    candidates: [{ ...f.candidate, revision: "newer" }],
  });
  await act(async () => {
    await capability.refresh();
  });

  expect(screen.getByRole("dialog", { name: "Update Notes" })).toBeVisible();
  fireEvent.click(within(review).getByRole("button", { name: "Update" }));

  expect(await within(review).findByRole("alert")).toHaveTextContent(
    "The update candidate changed after it was checked. Check for updates again before reviewing it.",
  );
  expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe("reviewing");
  expect(f.installImport).not.toHaveBeenCalled();
  fireEvent.click(within(review).getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe("failed"),
  );
});

it("waits for another plugin review to release the shared review slot", async () => {
  const f = fixture();
  f.mount();
  await screen.findByRole("button", { name: "Update and reload" });
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");

  const releaseReview = f.installRequests.holdReview();
  let queue: ReturnType<typeof capability.queueUpdates>;
  try {
    act(() => {
      queue = capability.queueUpdates([token]);
    });
    const accepted = queue;
    if (!accepted) throw new Error("Expected an accepted fresh queue");
    expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe("queued");
    expect(screen.queryByRole("button", { name: /^Update$/ })).toBeNull();
  } finally {
    act(() => releaseReview());
  }
  const accepted = queue;
  if (!accepted) throw new Error("Expected an accepted fresh queue");
  const dialog = await screen.findByRole("dialog", { name: "Update Notes" });
  expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe("reviewing");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe(
      "cancelled",
    ),
  );
});

it("ends a queued review when another plugin review opens before confirmation", async () => {
  const f = fixture();
  f.mount();
  await screen.findByRole("button", { name: "Update and reload" });
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");

  let queue: ReturnType<typeof capability.queueUpdates>;
  act(() => {
    queue = capability.queueUpdates([token]);
  });
  const accepted = queue;
  if (!accepted) throw new Error("Expected an accepted fresh queue");
  await screen.findByRole("dialog", { name: "Update Notes" });

  let releaseReview: (() => void) | undefined;
  try {
    act(() => {
      releaseReview = f.installRequests.holdReview();
    });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Update Notes" })).toBeNull(),
    );
    expect(capability.getQueue(accepted.id)).toMatchObject({
      status: "failed",
      items: [
        {
          status: "failed",
          error:
            "Another plugin review opened. Close it before confirming this update.",
        },
      ],
    });
    expect(f.installImport).not.toHaveBeenCalled();
  } finally {
    act(() => releaseReview?.());
  }
});

it("keeps an update queued while a claimed install request acquires and releases its review hold", async () => {
  const f = fixture();
  f.mount();
  await screen.findByRole("button", { name: "Update and reload" });
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");

  const request = f.installRequests.request(f.source, {
    id: "example.market",
    name: "Market",
  });
  const requestId = f.installRequests.snapshot()?.id;
  if (requestId === undefined) throw new Error("Expected an install request");
  expect(f.installRequests.claim(requestId)).toBe(true);

  let releaseReview: (() => void) | undefined;
  let accepted: ReturnType<typeof capability.queueUpdates>;
  try {
    act(() => {
      accepted = capability.queueUpdates([token]);
    });
    if (!accepted) throw new Error("Expected an accepted fresh queue");
    expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe("queued");
    expect(screen.queryByRole("button", { name: /^Update$/ })).toBeNull();

    act(() => {
      releaseReview = f.installRequests.holdReview();
      f.installRequests.settle(requestId, "cancelled");
    });
    expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe("queued");
    expect(screen.queryByRole("button", { name: /^Update$/ })).toBeNull();
  } finally {
    act(() => {
      if (f.installRequests.snapshot()?.id === requestId)
        f.installRequests.settle(requestId, "cancelled");
      releaseReview?.();
    });
  }

  await expect(request).resolves.toBe("cancelled");
  if (!accepted) throw new Error("Expected an accepted fresh queue");
  const acceptedQueue = accepted;
  const confirm = await screen.findByRole("button", {
    name: /^Update$/,
  });
  const dialog = confirm.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Expected the update confirmation dialog");
  expect(capability.getQueue(acceptedQueue.id)?.items[0]?.status).toBe(
    "reviewing",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(capability.getQueue(acceptedQueue.id)?.items[0]?.status).toBe(
      "cancelled",
    ),
  );
});

it("fails a queued review when the fresh preview revision drifts before confirmation", async () => {
  const f = fixture();
  f.freshCandidate.revision = "newer";
  f.mount();
  await screen.findByRole("button", { name: "Update and reload" });
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");
  let queue: ReturnType<typeof capability.queueUpdates>;
  act(() => {
    queue = capability.queueUpdates([token]);
  });
  const accepted = queue;
  if (!accepted) throw new Error("Expected an accepted fresh queue");
  const review = await screen.findByRole("dialog", { name: "Update Notes" });
  expect(
    within(review).getByText(
      "The update candidate changed after it was checked. Check for updates again before reviewing it.",
    ),
  ).toBeVisible();
  expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe("reviewing");
  expect(f.installImport).not.toHaveBeenCalled();
  fireEvent.click(within(review).getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe("failed"),
  );
});

it("keeps a queued update retryable after its fresh preview cannot be loaded", async () => {
  const f = fixture();
  f.imports.git.mockRejectedValueOnce(new Error("SSH authentication failed"));
  f.mount();
  await screen.findByRole("button", { name: "Update and reload" });
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");

  let queue: ReturnType<typeof capability.queueUpdates>;
  act(() => {
    queue = capability.queueUpdates([token]);
  });
  const accepted = queue;
  if (!accepted) throw new Error("Expected an accepted fresh queue");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "SSH authentication failed",
  );
  expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe("reviewing");
  expect(f.installImport).not.toHaveBeenCalled();

  f.imports.git.mockResolvedValueOnce(f.fresh);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  const review = await screen.findByRole("dialog", { name: "Update Notes" });
  expect(within(review).getByRole("button", { name: "Update" })).toBeEnabled();
  expect(capability.getQueue(accepted.id)?.items[0]?.status).toBe("reviewing");
  expect(f.installImport).not.toHaveBeenCalled();
});

it("ends a queued review when the host invalidates its action before confirmation", async () => {
  const f = fixture();
  f.mount();
  await screen.findByRole("button", { name: "Update and reload" });
  const capability = f.installRequests.updates;
  const token = capability?.getSnapshot().candidates[0]?.token;
  if (!capability || !token) throw new Error("Expected a fresh update token");

  let queue: ReturnType<typeof capability.queueUpdates>;
  act(() => {
    queue = capability.queueUpdates([token]);
  });
  const accepted = queue;
  if (!accepted) throw new Error("Expected an accepted fresh queue");
  await screen.findByRole("dialog", { name: "Update Notes" });

  f.plugin.revision = "changed before confirmation";
  f.emit({ configuration: f.state().configuration });

  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Update Notes" })).toBeNull(),
  );
  expect(capability.getQueue(accepted.id)).toMatchObject({
    status: "failed",
    items: [
      {
        status: "failed",
        error: "The installed plugin changed after this update was checked.",
      },
    ],
  });
  expect(f.installImport).not.toHaveBeenCalled();
});

it.each(["discovered", "fresh", "publisher"] as const)(
  "requires confirmation when %s data requires review",
  async (kind) => {
    const f = fixture();
    if (kind === "discovered")
      f.candidate.manifest = {
        ...f.plugin.manifest,
        host: { files: true },
      };
    if (kind === "publisher") {
      f.candidate.publisher = "b".repeat(64);
      f.freshCandidate.publisher = "b".repeat(64);
    } else
      f.freshCandidate.manifest = {
        ...f.plugin.manifest,
        host: { files: true },
      };
    f.mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: kind === "fresh" ? "Update and reload" : "Review permissions",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Update Notes" });
    const confirm = await within(dialog).findByRole("button", {
      name: "Update",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(f.installImport).not.toHaveBeenCalled();
    if (kind === "publisher")
      expect(
        within(dialog).getByText(/Previous publisher: Unsigned/),
      ).toBeVisible();
    else
      expect(within(dialog).getByText("Read your files (added)")).toBeVisible();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(f.installImport).toHaveBeenCalledExactlyOnceWith(
        "immutable-preview",
        ".",
      ),
    );
  },
);

it("keeps Later updates in the Plugins menu and cancellation leaves the plugin running", async () => {
  const f = fixture();
  f.freshCandidate.manifest = {
    ...f.plugin.manifest,
    host: { files: true },
  };
  f.mount();
  const later = await screen.findByRole("button", {
    name: "Later",
  });
  fireEvent.click(later);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Update and reload" }),
    ).toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Plugins/ }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Update Notes" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Update Notes" });
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Update" }),
    ).toBeEnabled(),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.installImport).not.toHaveBeenCalled();
  expect(f.manager.change).not.toHaveBeenCalled();
});

it("can cancel while a fresh preview loads, then discards the late preview", async () => {
  const f = fixture();
  let resolve!: (preview: ImportPreview) => void;
  f.imports.git.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() => expect(f.imports.git).toHaveBeenCalledOnce());
  try {
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    await act(async () => {
      resolve(f.fresh);
    });
  }
  await waitFor(() =>
    expect(f.imports.discard).toHaveBeenCalledWith("immutable-preview"),
  );
  expect(f.installImport).not.toHaveBeenCalled();
  expect(f.manager.change).not.toHaveBeenCalled();
});

it("shows an install failure in the review and permits a retry", async () => {
  const f = fixture();
  f.installImport.mockResolvedValueOnce(false);
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  const review = await screen.findByRole("dialog", { name: "Update Notes" });
  fireEvent.click(within(review).getByRole("button", { name: "Update" }));
  const error = await screen.findByRole("alert");
  expect(error).toHaveTextContent("Plugin installation wasn’t confirmed");
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "Update" }),
  );
  await waitFor(() => expect(f.installImport).toHaveBeenCalledTimes(2));
});

it("offers activation retry and the existing rollback confirmation outside Settings", async () => {
  const f = fixture();
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  const review = await screen.findByRole("dialog", { name: "Update Notes" });
  fireEvent.click(within(review).getByRole("button", { name: "Update" }));
  await waitFor(() => expect(f.installImport).toHaveBeenCalledOnce());
  await act(async () => {
    f.emit({
      activation: {
        "example.notes": {
          revision: "old",
          status: "failed",
          error: "Activation failed",
        },
      },
    });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry activation" }),
  );
  expect(f.manager.retryPlugin).toHaveBeenCalledWith("example.notes");
  fireEvent.click(
    screen.getByRole("button", { name: "Plugin recovery actions" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Roll back" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Roll back Notes?",
  });
  expect(f.manager.change).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(f.manager.change).not.toHaveBeenCalled();
});

it.each([true, false])(
  "preserves the managed pin and refuses a mismatched preview (matches: %s)",
  async (matches) => {
    const f = fixture();
    const configuration = f.state().configuration;
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    f.emit({
      configuration: {
        ...configuration,
        managed: {
          status: "ready",
          path: "policy",
          source: "Example",
          problems: [],
          plugins: [
            {
              id: f.plugin.manifest.id,
              ...f.source,
              commit: "a".repeat(40),
              state: "outdated",
            },
          ],
        },
      },
    });
    if (!matches) f.fresh.commit = "b".repeat(40);
    f.mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Update and reload" }),
    );
    await waitFor(() =>
      expect(f.imports.git).toHaveBeenCalledWith(
        f.source.repository,
        "main",
        undefined,
        "a".repeat(40),
      ),
    );
    if (matches) {
      const dialog = await screen.findByRole("dialog", {
        name: "Update Notes",
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Update" }));
      await waitFor(() => expect(f.installImport).toHaveBeenCalledOnce());
    } else {
      expect(
        await screen.findByText(/not at the commit that was requested/),
      ).toBeVisible();
      expect(f.installImport).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    }
  },
);

it("retires a pending preview when the saved source changes", async () => {
  const f = fixture();
  let resolve!: (preview: ImportPreview) => void;
  f.imports.git.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  await waitFor(() => expect(f.imports.git).toHaveBeenCalledOnce());
  try {
    const configuration = f.state().configuration;
    if (configuration.status !== "ready") throw new Error("Expected catalog");
    act(() =>
      f.emit({
        configuration: {
          ...configuration,
          catalog: {
            ...configuration.catalog,
            plugins: [
              {
                ...f.plugin,
                updateSource: { ...f.source, reference: "other" },
              },
            ],
          },
        },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    await act(async () => {
      resolve(f.fresh);
    });
  }
  expect(f.installImport).not.toHaveBeenCalled();
  expect(f.imports.discard).toHaveBeenCalledWith("immutable-preview");
});

it("requires review when a fresh update removes a process artifact constraint", async () => {
  const f = fixture();
  const process = { id: "worker", program: "worker", args: [] };
  f.plugin.manifest = {
    ...f.plugin.manifest,
    host: {
      processes: [
        {
          ...process,
          artifact: { path: "bin/worker", sha256: "a".repeat(64) },
        },
      ],
    },
  };
  f.candidate.manifest = f.plugin.manifest;
  f.freshCandidate.manifest = {
    ...f.plugin.manifest,
    host: { processes: [process] },
  };
  f.mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Update and reload" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Update Notes" });
  const confirm = await within(dialog).findByRole("button", { name: "Update" });
  await waitFor(() => expect(confirm).toBeEnabled());
  expect(f.installImport).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: /Start worker/ }));
  await waitFor(() =>
    expect(within(dialog).getByText("bin/worker")).toBeVisible(),
  );
  fireEvent.click(confirm);
  await waitFor(() => expect(f.installImport).toHaveBeenCalledOnce());
});
