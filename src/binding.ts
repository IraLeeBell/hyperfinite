import { digest } from "./canonical.js";
import type { Digest, WorkAccord } from "./types.js";

export function workAccordBindingDigest(accord: WorkAccord): Digest {
  return digest({
    repositoryId: accord.binding.repositoryId,
    sourceDigest: accord.binding.sourceDigest,
    workItemNodeId: accord.binding.workItemNodeId
  });
}
