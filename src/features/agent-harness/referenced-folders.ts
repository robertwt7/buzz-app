// Folders an owner's message references with `!` chips, handed to the agent
// for that turn. Anyone in a chat can sign a folder chip, so only the owner's
// own chips count, and only for a folder their repositories folder on this
// device lists now.
import { invoke } from "@tauri-apps/api/core";
import {
  repositoryFolders,
  type RepositoryFolder,
} from "../communities/repositories";
import { readMessageTokens } from "../messages/message-tokens";
import type { EventData } from "../relay/events";

export type ReferencedFolders = Readonly<{
  /** The prompt section; empty when there are none. */
  section: string;
  directories: readonly string[];
}>;

const NONE: ReferencedFolders = Object.freeze({ section: "", directories: [] });
/** How long a turn waits for the repositories folder listing. */
const LIST_TIMEOUT_MS = 4_000;

export async function referencedFolders(
  event: Pick<EventData, "pubkey" | "tags">,
  owner: string | undefined,
  scope: string | undefined,
  list = (path: string) =>
    invoke<readonly RepositoryFolder[]>("repositories_folder_list", { path }),
): Promise<ReferencedFolders> {
  if (!owner || !scope || event.pubkey !== owner) return NONE;
  let ids: string[];
  try {
    ids = readMessageTokens(event.tags)
      .filter((token) => token.kind === "folder")
      .map((token) => token.id);
  } catch {
    return NONE;
  }
  if (!ids.length) return NONE;
  try {
    const listed = new Set(
      (
        await repositoryFolders(
          scope,
          AbortSignal.timeout(LIST_TIMEOUT_MS),
          list,
        )
      ).map((folder) => folder.path),
    );
    const directories = ids.filter((id) => listed.has(id));
    if (!directories.length) return NONE;
    const quoted = directories
      .map((folder) =>
        JSON.stringify(folder)
          .replaceAll("<", "\\u003c")
          .replaceAll(">", "\\u003e"),
      )
      .join(", ");
    return {
      section: `<referenced-folders>\nThe owner's message references these folders on this device (literal paths): ${quoted}. \`cd\` into the one you need; your workspace keeps your notes.\n</referenced-folders>`,
      directories,
    };
  } catch (error) {
    console.warn("Could not check the referenced folders", error);
    return NONE;
  }
}
