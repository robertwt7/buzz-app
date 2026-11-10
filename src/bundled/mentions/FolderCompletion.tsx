import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import {
  repositoriesFolder,
  repositoryFolders,
  type RepositoryFolder,
} from "../../features/communities/repositories";
import type { HostCompletionResult } from "../../features/conversation/completion";
import type {
  CompletionResult,
  ComposerCompletionProps,
} from "../../features/conversation/contracts";

/** `!` after a boundary, as `@` mentions are matched, once a query character
 * follows it. A bare `!` or one followed by a space is prose, and `![` starts
 * Markdown image syntax. */
export function folderQuery(text: string, caret: number) {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(Math.max(0, caret - 160), caret);
  const match = before.match(/(?:^|[\s([{])!([^![\s][^![\n\r\t]*)$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = caret - query.length - 1;
  // A bounded slice beginning in the middle of a word is not a boundary.
  if (start && !/[\s([{]/u.test(text[start - 1] ?? "")) return null;
  return { start, end: caret, query };
}

type Listing = Readonly<{ rows: readonly RepositoryFolder[]; error?: string }>;
type Held = {
  key: string;
  controller: AbortController;
  listing: Promise<Listing>;
  holders: number;
};
let last: Held | undefined;

function retire(held: Held) {
  held.controller.abort();
  if (last === held) last = undefined;
}

function hold(scope: string, key: string) {
  if (last?.key !== key) {
    // A new `!` query retires the previous one's listing.
    if (last) retire(last);
    const controller = new AbortController();
    const listing = repositoryFolders(scope, controller.signal, (path) =>
      invoke<readonly RepositoryFolder[]>("repositories_folder_list", { path }),
    ).then(
      (rows) => ({ rows }),
      (reason: unknown) => ({
        rows: [],
        error: reason instanceof Error ? reason.message : String(reason),
      }),
    );
    last = { key, controller, listing, holders: 0 };
  }
  last.holders += 1;
  return last;
}

function release(held: Held) {
  held.holders -= 1;
  // A keystroke remounts the provider in the same commit, so its next mount
  // holds the listing before this runs. A closed query has no holder by then.
  queueMicrotask(() => {
    if (!held.holders) retire(held);
  });
}

function preference(scope: string) {
  try {
    return repositoriesFolder(scope);
  } catch {
    // The listing reports why the folder cannot be read.
    return "";
  }
}

/** The community's repositories folders for one open `!` query, listed once
 * however often the host remounts its completion. Reopening the query, a
 * changed preference or `retry` lists them again. Desktop only. */
function useFolders(scope: string, lifetime: string) {
  const key = JSON.stringify([scope, lifetime, preference(scope)]);
  const [attempt, setAttempt] = useState(0);
  const [listed, setListed] = useState<{
    key: string;
    attempt: number;
    listing: Listing;
  }>();
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const held = hold(scope, key);
    void held.listing.then((listing) => {
      if (live) setListed({ key, attempt, listing });
    });
    return () => {
      live = false;
      release(held);
    };
  }, [scope, key, attempt]);
  const retry = useCallback(() => {
    if (last?.key === key) retire(last);
    setAttempt((value) => value + 1);
  }, [key]);
  const listing =
    listed?.key === key && listed.attempt === attempt
      ? listed.listing
      : undefined;
  return useMemo(() => listing && { ...listing, retry }, [listing, retry]);
}

/** `!` on desktop offers the immediate folders of the community's
 * repositories folder as folder chips. */
export function FolderCompletion({
  scope,
  channelId,
  threadRootId,
  query,
  publish,
}: Pick<
  ComposerCompletionProps,
  "scope" | "channelId" | "threadRootId" | "query" | "publish"
>) {
  // The host remounts this provider on every keystroke. One `!` token in one
  // composer is the lifetime that lists the folders once.
  const folders = useFolders(
    scope,
    JSON.stringify([channelId, threadRootId, query.start]),
  );
  useLayoutEffect(() => {
    if (!folders) return;
    const needle = query.query.trim().toLowerCase();
    const items = folders.rows
      .filter((folder) => folder.name.toLowerCase().includes(needle))
      .map((folder) => ({
        id: `folder:${folder.path}`,
        label: folder.name,
        detail: `Local folder · ${folder.displayPath}`,
        edit: {
          token: {
            kind: "folder" as const,
            id: folder.path,
            label: folder.name,
          },
        },
      }));
    // A query that names no folder is prose, not a search.
    if (!items.length && !folders.error) return;
    const result: HostCompletionResult = folders.error
      ? { items, status: folders.error, retry: folders.retry }
      : { items };
    // The host accepts a chip edit only from a bundled provider.
    const withdraw = publish(result as unknown as CompletionResult);
    return () => {
      if (withdraw) withdraw();
    };
  }, [folders, query.query, publish]);
  return null;
}
