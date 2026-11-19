import type { OptimisticLocalStore } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { byRank, rankInLoaded } from "@/lib/sort-order";
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

/**
 * The rank for the card at `index` of `column`, the target column's loaded cards in order with the card in place.
 * `floor` is the lowest rank of all the team's loaded issues, whatever the filter, and `loadedRanks` holds each one's
 * rank by id. A card alone in its column keeps its rank.
 * A card moved in from another column keeps its rank where its spot can't be ranked: its status still changes, and an
 * unchanged rank never makes the server re-space a tie.
 */
export function dropRank(
  column: Card[],
  index: number,
  moreToLoad: boolean,
  floor: number | undefined,
  loadedRanks: ReadonlyMap<Id<"issues">, number>,
  fromOtherColumn: boolean
) {
  const card = column[index];
  if (column.length === 1) {
    return { sortOrder: card.sortOrder };
  }
  const taken = new Set([...loadedRanks].flatMap(([id, rank]) => (id === card._id ? [] : [rank])));
  const drop = rankInLoaded({ above: column[index - 1]?.sortOrder, below: column[index + 1]?.sortOrder, floor, taken, moreToLoad });
  return "refused" in drop && fromOtherColumn ? { sortOrder: card.sortOrder } : drop;
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
