import type { ContextConnection, ContextThought } from "../explore/results";

export type IdeaThought = ContextThought & { readonly rejected?: boolean };
export type IdeaConnection = ContextConnection & { readonly rejected?: boolean };
export interface SharedResponse { readonly id: string; readonly text: string; readonly role: "addendum" | "fallback"; readonly state: "complete" | "interrupted"; readonly thoughtIds: readonly string[]; }
export interface IdeaView {
  readonly thought: IdeaThought;
  readonly parent: { readonly id: string; readonly thought: IdeaThought | null } | null;
  readonly children: readonly IdeaThought[];
  readonly sources: readonly { readonly id: string; readonly thought: IdeaThought | null }[];
  readonly connections: readonly { readonly connection: IdeaConnection; readonly thought: IdeaThought | null }[];
  readonly responses: readonly SharedResponse[];
  readonly focusedResponse: SharedResponse | null;
}
export interface BranchPreview { readonly rootId: string; readonly branchIds: readonly string[]; readonly affectedIds: readonly string[]; readonly count: number; }
export interface CreateConnectionCommand {
  readonly action: "create-connection";
  readonly thoughtId: string;
  readonly fromId: string;
  readonly toId: string;
  readonly category: "supports" | "contradicts" | "extends" | "related";
  readonly explanation: string;
  readonly sourceIds?: readonly string[];
}
export type IdeaCommand =
  | CreateConnectionCommand
  | { readonly action: "title"; readonly thoughtId: string; readonly title: string | null }
  | { readonly action: "reject-thought" | "restore-thought" | "restore-branch"; readonly thoughtId: string }
  | { readonly action: "reject-connection" | "restore-connection"; readonly thoughtId: string; readonly connectionId: string }
  | { readonly action: "reject-branch"; readonly thoughtId: string; readonly preview: BranchPreview };
export type CommandResult = { readonly kind: "applied"; readonly thought?: IdeaThought }
  | { readonly kind: "not-applied" | "conflict" | "uncertain"; readonly message: string; readonly command: IdeaCommand };
