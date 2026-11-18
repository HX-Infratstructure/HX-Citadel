/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG_CLAIM = "org_test";
const MEMBER_CLERK_ID = "user_member";

async function setup() {
  const t = convexTest(schema, modules);
  const { orgId, teamId, memberId } = await t.run(async (ctx) => {
    const memberId = await ctx.db.insert("users", {
      clerkId: MEMBER_CLERK_ID,
      name: "Member",
      email: "member@example.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: ORG_CLAIM,
      name: "Test Org",
      slug: "test-org",
    });
    await ctx.db.insert("members", {
      orgId,
      userId: memberId,
      role: "member",
      clerkMembershipId: "mem_member",
    });
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Citadel",
      key: "HXT",
      nextIssueNumber: 7,
    });
    return { orgId, teamId, memberId };
  });
  const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });

  const createIssue = () =>
    asMember.mutation(api.issues.create, { teamId, title: "A story", kind: "story" });

  const storeFile = () => t.run((ctx) => ctx.storage.store(new Blob(["proof"])));

  const attach = (issueId: Id<"issues">, storageId: Id<"_storage">) =>
    asMember.mutation(api.attachments.create, {
      issueId,
      storageId,
      fileName: "proof.txt",
      fileType: "text/plain",
      fileSize: 5,
    });

  /** Shared rows can only exist from data written before `create` refused them. */
  const insertSharedRow = (issueId: Id<"issues">, storageId: Id<"_storage">) =>
    t.run((ctx) =>
      ctx.db.insert("attachments", {
        orgId,
        issueId,
        storageId,
        fileName: "proof.txt",
        fileType: "text/plain",
        fileSize: 5,
        uploadedBy: memberId,
      })
    );

  const removeAttachment = (attachmentId: Id<"attachments">) =>
    asMember.mutation(api.attachments.remove, { attachmentId });

  const storedFile = (storageId: Id<"_storage">) => t.run((ctx) => ctx.db.system.get(storageId));

  const asOtherMember = async () => {
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "user_other", name: "Other", email: "other@example.com" });
      await ctx.db.insert("members", { orgId, userId, role: "member", clerkMembershipId: "mem_other" });
    });
    return t.withIdentity({ subject: "user_other", org_id: ORG_CLAIM });
  };

  return { createIssue, storeFile, attach, insertSharedRow, removeAttachment, storedFile, asOtherMember };
}

describe("attachments keep one owner per stored file", () => {
  test("create refuses a file another attachment already uses", async () => {
    const { createIssue, storeFile, attach } = await setup();
    const firstId = await createIssue();
    const secondId = await createIssue();
    const file = await storeFile();
    await attach(firstId, file);

    await expect(attach(secondId, file)).rejects.toThrow("This file is already attached");
    await expect(attach(firstId, file)).rejects.toThrow("This file is already attached");
  });

  test("create accepts a file no attachment uses", async () => {
    const { createIssue, storeFile, attach } = await setup();
    const issueId = await createIssue();

    await attach(issueId, await storeFile());
    await attach(issueId, await storeFile());
  });

  test("removing one of two attachments that share a file keeps the file", async () => {
    const { createIssue, storeFile, attach, insertSharedRow, removeAttachment, storedFile } =
      await setup();
    const firstId = await createIssue();
    const secondId = await createIssue();
    const file = await storeFile();
    const firstAttachment = await attach(firstId, file);
    const secondAttachment = await insertSharedRow(secondId, file);

    await removeAttachment(firstAttachment);
    expect(await storedFile(file)).not.toBeNull();

    await removeAttachment(secondAttachment);
    expect(await storedFile(file)).toBeNull();
  });
});

describe("attachments.remove", () => {
  test("a member who neither uploaded the file nor is an admin gets a typed rule refusal, and the file stays", async () => {
    const { createIssue, storeFile, attach, storedFile, asOtherMember } = await setup();
    const file = await storeFile();
    const attachmentId = await attach(await createIssue(), file);
    const other = await asOtherMember();

    const refusal = await other.mutation(api.attachments.remove, { attachmentId }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConvexError);
    expect((refusal as ConvexError<{ code: string; message: string }>).data).toEqual({
      code: "rule_refused",
      message: "Only the uploader or an admin can delete an attachment",
    });
    expect(await storedFile(file)).not.toBeNull();
  });
});
