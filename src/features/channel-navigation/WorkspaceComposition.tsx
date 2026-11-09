import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useEffectEvent,
  useRef,
  type ReactNode,
} from "react";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import { PencilSimpleIcon } from "../../shared/design-system/icons";
import type { LeadsSnapshot } from "../relay/solo-preferences";
import { SoloDisclosure } from "./SoloDisclosure";
import type { SoloWorkspaceProps } from "./solo-navigation-contract";
import styles from "./WorkspaceComposition.module.css";

/** The existing Solo inventory retains every row, menu, mutation and disclosure. */
export type WorkspaceComposition = Readonly<{
  leadDraft?: string;
  /** The separate Leads record. Until it is read, a Lead workspace is not selected. */
  leads?: Readonly<{
    status: LeadsSnapshot["status"];
    refresh(): Promise<boolean>;
  }>;
  ordinary: ReactNode;
  chats: ReactNode;
  workspaces: readonly Readonly<{
    id: string;
    name: string;
    open: boolean;
    toggle(open: boolean): void;
    frame(children: ReactNode): ReactNode;
    header(
      primary: ReactNode,
      trailing?: ReactNode,
      actions?: ReactNode,
    ): ReactNode;
    panel(before?: ReactNode): ReactNode;
  }>[];
}>;
export type ComposeWorkspaces = (parts: WorkspaceComposition) => ReactNode;
export const WorkspaceCompositionContext = createContext<
  WorkspaceComposition | undefined
>(undefined);

/** Ordinary chats remain available in task views that group by status or time. */
export function RegionChats({ all = false }: { all?: boolean }) {
  const parts = useContext(WorkspaceCompositionContext);
  return (all ? parts?.ordinary : parts?.chats) ?? null;
}

/** One shared workspace surface. A source supplies tasks and its optional lead. */
export function RegionWorkspace(props: SoloWorkspaceProps) {
  const parts = useContext(WorkspaceCompositionContext);
  const workspace = parts?.workspaces.find(
    (item) => item.id === (props.id ?? ""),
  );
  const reveal = useEffectEvent(() => workspace?.toggle(true));
  useLayoutEffect(() => {
    if (props.reveal) reveal();
  }, [props.reveal]);
  const reading = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const leads = props.leadWorkspaceId ? parts?.leads : undefined;
  // An unread Lead is not an absent one: its draft could duplicate the Lead.
  const select = async () => {
    if (!leads || leads.status === "ready") {
      props.onSelect?.();
      return;
    }
    if (reading.current) return;
    reading.current = true;
    try {
      if ((await leads.refresh()) && mounted.current) props.onSelect?.();
    } finally {
      reading.current = false;
    }
  };
  if (!workspace || !props.id) return null;
  const title = props.id ? workspace.name : "Unfiled";
  const disclosure = (
    <SoloDisclosure
      label={`${workspace.open ? "Hide" : "Show"} tasks and chats in ${title}`}
      summary={props.id ? "" : title}
      expanded={workspace.open}
      controls={`workspace-${workspace.id || "unfiled"}`}
      onToggle={() => workspace.toggle(!workspace.open)}
    />
  );
  const primary = props.id ? (
    <div className={styles.heading}>
      <NavigationItem
        label={title}
        selected={
          !!props.selected ||
          (!!props.leadWorkspaceId &&
            parts?.leadDraft === props.leadWorkspaceId)
        }
        data-solo-workspace-id={workspace.id}
        onClick={() => void select()}
      />
      {disclosure}
    </div>
  ) : (
    disclosure
  );
  return workspace.frame(
    <div data-solo-workspace={workspace.id}>
      <NavigationCard
        tone="tonal"
        data-drop-target={props.dropTarget || undefined}
        footer={
          leads?.status === "error" && (
            <p role="alert" className="text-body-sm text-danger">
              Lead unavailable.{" "}
              <Button
                variant="plain"
                size="inline"
                onClick={() => void leads.refresh()}
              >
                Retry
              </Button>
            </p>
          )
        }
        body={workspace.panel(props.children)}
      >
        {workspace.header(
          primary,
          props.onNewTask && (
            <IconButton
              size="compact"
              data-solo-workspace-new-task=""
              aria-label={`New task in ${title}`}
              title="New task"
              icon={<PencilSimpleIcon size={15} />}
              onClick={props.onNewTask}
            />
          ),
          props.onNewTask && (
            // Also in the menu, where it is never hidden.
            <MenuItem onClick={props.onNewTask}>New task</MenuItem>
          ),
        )}
      </NavigationCard>
    </div>,
  );
}
