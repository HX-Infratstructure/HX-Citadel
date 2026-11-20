import { v } from "convex/values";
import { issueFields } from "../../schema";

export const issueShape = { _id: v.id("issues"), _creationTime: v.number(), ...issueFields };
