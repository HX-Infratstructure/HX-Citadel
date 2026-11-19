import type { OptimisticLocalStore } from "convex/browser";

/** Test double: a Convex local store over loaded `queries`, whose `setQuery` replaces the value of the entry it is given the args of. */
export function fakeLocalStore<Args, Value>(queries: { args: Args; value: Value }[]): OptimisticLocalStore {
  return {
    getAllQueries: () => queries.map(({ args, value }) => ({ args, value })),
    setQuery: (_query: unknown, args: Args, value: Value) => {
      queries.find((entry) => entry.args === args)!.value = value;
    },
  } as unknown as OptimisticLocalStore;
}
