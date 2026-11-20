import type { OptimisticLocalStore } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { byRank, type DropOutcome, type LoadedOrder, rankInLoaded } from "@/lib/sort-order";
import type { IssueStatus } from "@/components/shared/issue-meta";

type Card = { _id: Id<"issues">; status: IssueStatus; sortOrder: number; _creationTime: number };
type BoardUpdate = { issueId: Id<"issues">; status?: IssueStatus; sortOrder?: number };

export type Columns = Record<IssueStatus, Id<"issues">[]>;

function emptyColumns(): Columns {
  return {
    backlog: [],
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
    canceled: [],
  };
}

/** One column per status, each highest first, in the order the server pages them. */
export function boardColumns(issues: Card[]): Columns {
  const columns = emptyColumns();
  for (const issue of [...issues].sort(byRank)) {
    columns[issue.status].push(issue._id);
  }
  return columns;
}

/** The card right above the card at `index` of `column`: the neighbour `dropRank` ranks under. */
function cardAbove(column: Card[], index: number): Card | undefined {
  return column[index - 1];
}

/** The loaded card a drop at `index` of `column` lands right under, the one `dropRank` ranks against; null at the top. */
export function boardAnchor(column: Card[], index: number): Id<"issues"> | null {
  return cardAbove(column, index)?._id ?? null;
}

/**
 * What a drop does to the card at `index` of `column`, the target column's loaded cards in order with the card in
 * place. `loaded` is the team's loaded rank order, whatever the filter.
 * A card alone in its column keeps its rank.
 * A card moved in from another column keeps its rank where its spot can't be ranked or ranks at its own rank: its
 * status still changes, and an unchanged rank never makes the server re-space a tie.
 */
export function dropRank({ column, index, loaded, fromOtherColumn }: {
  column: Card[];
  index: number;
  loaded: LoadedOrder;
  fromOtherColumn: boolean;
}): DropOutcome {
  if (column.length === 1) {
    return { kind: "inPlace" };
  }
  const own = column[index].sortOrder;
  const above = cardAbove(column, index)?.sortOrder;
  const drop = rankInLoaded({ above, below: column[index + 1]?.sortOrder, own, ...loaded });
  return fromOtherColumn && drop.kind === "refused" ? { kind: "inPlace" } : drop;
}

/** Patches a card's status and rank in place on every loaded page of the team's board; the board sorts in the browser. */
export function updateBoard(localStore: OptimisticLocalStore, teamId: Id<"teams">, update: BoardUpdate) {
  const patch = {
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(update.sortOrder !== undefined ? { sortOrder: update.sortOrder } : {}),
  };
  for (const { args, value } of localStore.getAllQueries(api.issues.listByTeam)) {
    if (value && args.teamId === teamId) {
      localStore.setQuery(api.issues.listByTeam, args, {
        ...value,
        page: value.page.map((issue) => (issue._id === update.issueId ? { ...issue, ...patch } : issue)),
      });
    }
  }
}
