import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PluginManager } from "../plugins/manager";
import { pendingManaged } from "../plugins/managed";
import { canRetryPlugin } from "../plugins/manager";
import type { PluginInstallRequests } from "../plugins/installer";
import {
  createPluginUpdates,
  type PluginUpdate,
  type PluginUpdates as Updates,
  pluginUpdateSource,
  updateSourceKey,
} from "../plugins/updates";
import type { AppServices } from "./services";
import { Button } from "../shared/design-system/ui/Button";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import {
  MenuItem,
  MenuSubmenu,
  MenuSubmenuTrigger,
  MenuSubmenuPopup,
  MenuIcon,
  MenuSeparator,
  MenuTrailing,
} from "../shared/design-system/ui/Menu";
import { SquaresFourIcon } from "../shared/design-system/icons";
import { RecommendationCount } from "./RecommendationCount";
import { PluginImport } from "./PluginImport";
import { pluginAccessIncreases } from "./PluginAccessReview";
import { PluginMenu } from "./PluginMenu";

const Context = createContext<{
  updates: readonly PluginUpdate[];
  recommended: readonly string[];
  busy: boolean;
  open(update: PluginUpdate): void;
} | null>(null);
const noSubscribe = () => () => {};
const empty: readonly PluginUpdate[] = [];
const noUpdates = () => empty;
const noQueueRevision = () => 0;

export function PluginUpdates({
  plugins,
  relay,
  installRequests,
  navigation,
  children,
}: {
  plugins: PluginManager;
  relay: AppServices["relay"];
  installRequests: PluginInstallRequests;
  navigation: Pick<AppServices["navigation"], "open">;
  children: ReactNode;
}) {
  const [store, setStore] = useState<Updates>();
  const [action, setAction] = useState<PluginUpdate>();
  const [actionQueueId, setActionQueueId] = useState<string>();
  const reviewLeaseRevision = useRef<number | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);
  const state = useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const updates = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.snapshot ?? noUpdates,
  );
  const queueRevision = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.revision ?? noQueueRevision,
  );
  const reviewRevision = useSyncExternalStore(
    installRequests.subscribeReview,
    installRequests.reviewRevision,
  );
  const authorizeGit = async (repository: string) =>
    (await relay.snapshot().session.authorizeGit?.(repository)) ?? null;
  useEffect(() => {
    const updates = createPluginUpdates(
      plugins,
      async (repository) =>
        (await relay.snapshot().session.authorizeGit?.(repository)) ?? null,
    );
    setStore(updates);
    const unregisterUpdates = installRequests.registerUpdates(
      updates.capability,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const visible = () => document.visibilityState !== "hidden";
    const check = async () => {
      clearTimeout(timer);
      if (!visible()) return;
      const delay = await updates.check();
      if (delay === undefined || disposed || !visible()) return;
      clearTimeout(timer);
      timer = setTimeout(check, delay);
    };
    void check();
    const unsubscribe = plugins.subscribe(check);
    document.addEventListener("visibilitychange", check);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
      unsubscribe();
      unregisterUpdates();
      updates.dispose();
    };
  }, [plugins, relay, installRequests]);
  const configuration = state.configuration;
  const catalog =
    configuration.status === "ready" ? configuration.catalog : undefined;
  const open = (update: PluginUpdate) => {
    if (state.busy || action || !update.token) return;
    returnFocus.current = document.activeElement as HTMLElement;
    if (!store?.capability.queueUpdates([update.token]))
      void store?.check(true);
  };
  useEffect(() => {
    if (
      !store ||
      action ||
      queueRevision !== store.revision() ||
      reviewRevision !== installRequests.reviewRevision()
    )
      return;
    const review = store.startNextReview(installRequests.tryHoldReview);
    if (!review) return;
    reviewLeaseRevision.current = installRequests.reviewRevision();
    returnFocus.current = document.activeElement as HTMLElement;
    setAction(review.update);
    setActionQueueId(review.queueId);
  }, [store, action, queueRevision, reviewRevision, installRequests]);
  const activeReview = store?.getActiveReview();
  const endReview = useCallback(
    (review: NonNullable<typeof activeReview>, error?: string) =>
      store?.endReview(review.queueId, review.token, error),
    [store],
  );
  const installed =
    action && catalog?.plugins.find((p) => p.manifest.id === action.id);
  const source = action && pluginUpdateSource(plugins, action.id);
  // Keep stale tokens rendered so their explicit confirmation guard can explain the refusal.
  const validAction =
    action &&
    installed &&
    source &&
    action.token &&
    activeReview &&
    actionQueueId !== undefined &&
    activeReview.queueId === actionQueueId &&
    activeReview.token === action.token &&
    reviewLeaseRevision.current === installRequests.reviewRevision() &&
    installed.revision === action.installedRevision &&
    updateSourceKey(source) === updateSourceKey(action.source);
  const review = activeReview;
  const reviewToken = action?.token;
  const queuedUpdate =
    reviewToken &&
    actionQueueId !== undefined &&
    review &&
    review.queueId === actionQueueId &&
    review.token === reviewToken
      ? {
          validate: () =>
            reviewLeaseRevision.current === installRequests.reviewRevision()
              ? store?.isCurrentToken(reviewToken)
                ? undefined
                : "The update candidate changed after it was checked. Check for updates again before reviewing it."
              : "Another plugin review opened. Close it before confirming this update.",
          confirmed: () => store?.beginOperation(review.queueId, reviewToken),
          settled: (
            outcome: "installed" | "updated" | "cancelled" | "unavailable",
          ) => store?.finishReview(review.queueId, reviewToken, outcome),
          ended: (error?: string) => endReview(review, error),
        }
      : undefined;
  useEffect(() => {
    if (action && !validAction && !state.busy) {
      const review = store?.getActiveReview();
      if (
        review &&
        review.queueId === actionQueueId &&
        review.token === action.token
      )
        endReview(
          review,
          reviewLeaseRevision.current === installRequests.reviewRevision()
            ? "The installed plugin changed after this update was checked."
            : "Another plugin review opened. Close it before confirming this update.",
        );
      setAction(undefined);
      setActionQueueId(undefined);
    }
  }, [
    action,
    actionQueueId,
    validAction,
    state.busy,
    store,
    endReview,
    installRequests,
  ]);
  useEffect(() => {
    if (
      action &&
      (activeReview?.queueId !== actionQueueId ||
        activeReview?.token !== action.token)
    ) {
      setAction(undefined);
      setActionQueueId(undefined);
    }
  }, [action, actionQueueId, activeReview]);
  const needsReview = (update: PluginUpdate) => {
    const previous = catalog?.plugins.find((p) => p.manifest.id === update.id);
    return (
      !previous ||
      !update.candidate ||
      pluginAccessIncreases(update.candidate.manifest, previous.manifest) ||
      (update.candidate.publisher ?? null) !== (previous.publisher ?? null)
    );
  };
  const [recovering, setRecovering] = useState<readonly string[]>([]);
  return (
    <Context
      value={{
        updates,
        open,
        busy: state.busy || !!action,
        recommended: pendingManaged(
          configuration.status === "ready" ? configuration.managed : undefined,
        ).map((entry) => entry.id),
      }}
    >
      {children}
      {updates
        .filter((update) => !store?.hidden(update) && update.id !== action?.id)
        .map((update) => {
          const plugin = catalog?.plugins.find(
            (p) => p.manifest.id === update.id,
          );
          const review = needsReview(update);
          return (
            <ToastNotice
              key={update.id}
              title={
                update.error
                  ? `Cannot check ${plugin?.manifest.name ?? update.id}`
                  : `Update ${plugin?.manifest.name ?? update.id}`
              }
              description={
                update.error ??
                "Save unfinished forms and stop active plugin workers first. Updating an enabled plugin reloads it immediately."
              }
              tone={update.error ? "error" : "info"}
              onDismiss={() => store?.later(update)}
              closeLabel="Dismiss plugin update notice"
              navigation={{
                label: `Manage ${plugin?.manifest.name ?? update.id} update checks`,
                open: () =>
                  void navigation.open({
                    version: 1,
                    kind: "settings",
                    section: "plugins",
                    pluginId: update.id,
                  }),
              }}
            >
              <Button
                size="sm"
                disabled={state.busy || !!action}
                onClick={() =>
                  update.error ? void store?.check(true) : open(update)
                }
              >
                {update.error
                  ? "Retry"
                  : review
                    ? "Review permissions"
                    : "Update and reload"}
              </Button>
              <Button size="sm" onClick={() => store?.later(update)}>
                Later
              </Button>
            </ToastNotice>
          );
        })}
      {validAction && catalog && (
        <PluginImport
          key={`${action.id}:${updateSourceKey(action.source)}:${action.token}`}
          plugins={plugins}
          catalog={catalog}
          busy={state.busy}
          updateId={action.id}
          updateAction={{
            source: action.source,
            apply: false,
            ...(action.candidate
              ? {
                  candidateRevision: action.candidate.revision,
                  candidatePublisher: action.candidate.publisher ?? null,
                }
              : {}),
          }}
          reviewRequested
          authorizeGit={authorizeGit}
          returnFocus={() => returnFocus.current}
          queuedUpdate={queuedUpdate}
          onClosed={() => {
            setRecovering((ids) =>
              ids.includes(action.id) ? ids : [...ids, action.id],
            );
            setAction(undefined);
          }}
        />
      )}
      {catalog?.plugins
        .filter((plugin) => recovering.includes(plugin.manifest.id))
        .map((recovery) => {
          const activation = state.activation[recovery.manifest.id];
          return activation?.status === "failed" ? (
            <ToastNotice
              key={recovery.manifest.id}
              title={`${recovery.manifest.name} cannot start`}
              description={`${activation.error}${recovery.rollbackBlockedReason ? ` ${recovery.rollbackBlockedReason}` : ""}`}
              tone="error"
            >
              <Button
                size="sm"
                disabled={
                  state.busy ||
                  !canRetryPlugin(
                    recovery,
                    activation,
                    configuration.status === "ready" &&
                      configuration.externalPluginsPaused,
                  )
                }
                onClick={() => plugins.retryPlugin(recovery.manifest.id)}
              >
                Retry activation
              </Button>
              <PluginMenu
                plugin={recovery}
                plugins={plugins}
                busy={state.busy}
                label="Plugin recovery actions"
              />
            </ToastNotice>
          ) : null;
        })}
    </Context>
  );
}

export function PluginUpdatesMenu({
  onManage,
  recommendations,
}: {
  onManage(): void;
  recommendations: number;
}) {
  const context = useContext(Context);
  const updates = context?.updates ?? empty;
  const count =
    recommendations +
    updates.filter((update) => !context?.recommended.includes(update.id))
      .length;
  const label = (
    <>
      <MenuIcon>
        <SquaresFourIcon aria-hidden="true" size={16} />
      </MenuIcon>
      Plugins
      {count > 0 && (
        <MenuTrailing>
          <RecommendationCount count={count} />
        </MenuTrailing>
      )}
    </>
  );
  if (!updates.length) return <MenuItem onClick={onManage}>{label}</MenuItem>;
  return (
    <MenuSubmenu>
      <MenuSubmenuTrigger>{label}</MenuSubmenuTrigger>
      <MenuSubmenuPopup>
        {updates.map((update) => (
          <MenuItem
            key={update.id}
            disabled={context?.busy}
            onClick={() => context?.open(update)}
          >
            {update.error ? "Retry update" : "Update"}{" "}
            {update.candidate?.manifest.name ?? update.id}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={onManage}>Manage plugins</MenuItem>
      </MenuSubmenuPopup>
    </MenuSubmenu>
  );
}
