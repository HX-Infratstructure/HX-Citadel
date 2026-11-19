/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("users.current", () => {
  test("returns a user row that has kind set", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "user_kind",
        name: "Kind",
        email: "kind@example.com",
        kind: "human",
      })
    );

    const user = await t.withIdentity({ subject: "user_kind" }).query(api.users.current, {});

    expect(user).toMatchObject({ clerkId: "user_kind", kind: "human" });
  });
});
