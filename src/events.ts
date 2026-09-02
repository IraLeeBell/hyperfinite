import { digest } from "./canonical.js";
import type { Digest, EventEnvelope } from "./types.js";

export function eventPayloadDigest(event: EventEnvelope): Digest {
  const {
    provenance: { payloadDigest: _payloadDigest, ...provenance },
    ...envelope
  } = event;
  return digest({ ...envelope, provenance });
}
