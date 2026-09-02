import { workAccordBindingDigest } from "./binding.js";
import { digest } from "./canonical.js";
import type { Digest, TransitionReceipt, WorkAccord } from "./types.js";
import { validateDocument } from "./validation.js";

export interface ReceiptChainError {
  readonly index: number;
  readonly message: string;
}

export function verifyReceiptChain(
  receipts: readonly TransitionReceipt[],
  expectedTerminalHead: Digest,
  workAccord: WorkAccord,
  initialHead: Digest | null = null
): readonly ReceiptChainError[] {
  const errors: ReceiptChainError[] = [];
  const workAccordValidation = validateDocument("WorkAccord", workAccord);
  if (!workAccordValidation.valid) {
    return [
      {
        index: -1,
        message: `Work Accord schema is invalid: ${workAccordValidation.errors.join("; ")}`
      }
    ];
  }
  const expectedBindingDigest = workAccordBindingDigest(
    workAccordValidation.value
  );
  let expectedHead = initialHead;
  let prior: TransitionReceipt | null = null;

  receipts.forEach((receipt, index) => {
    const validation = validateDocument("TransitionReceipt", receipt);
    if (!validation.valid) {
      errors.push({
        index,
        message: `receipt schema is invalid: ${validation.errors.join("; ")}`
      });
    }
    if (receipt.previousReceipt !== expectedHead) {
      errors.push({
        index,
        message: "receipt does not reference the expected predecessor digest"
      });
    }
    if (
      receipt.bindingDigest !== expectedBindingDigest ||
      receipt.destinationBindingDigest !== expectedBindingDigest
    ) {
      errors.push({
        index,
        message: "receipt binding does not match the Work Accord target identity"
      });
    }
    if (prior !== null) {
      if (receipt.from !== prior.to) {
        errors.push({
          index,
          message: "receipt source does not match the prior destination"
        });
      }
      if (
        prior.stateVersion === Number.MAX_SAFE_INTEGER ||
        receipt.stateVersion !== prior.stateVersion + 1
      ) {
        errors.push({
          index,
          message: "receipt state version is not contiguous"
        });
      }
      if (
        receipt.bindingDigest !== prior.destinationBindingDigest ||
        receipt.lifecycleGraphDigest !==
          prior.destinationLifecycleGraphDigest ||
        receipt.workAccordDigest !== prior.destinationWorkAccordDigest ||
        receipt.capabilityRegistryDigest !==
          prior.destinationCapabilityRegistryDigest ||
        receipt.domainPackDigest !== prior.destinationDomainPackDigest ||
        receipt.policyDigest !== prior.destinationPolicyDigest
      ) {
        errors.push({
          index,
          message: "receipt source authority does not continue the prior destination"
        });
      }
      if (
        receipt.sourcePhaseContractDigest !==
          prior.destinationPhaseContractDigest ||
        receipt.sourceCompiledPolicyDigest !==
          prior.destinationCompiledPolicyDigest
      ) {
        errors.push({
          index,
          message: "receipt phase authority does not continue the prior handoff"
        });
      }
    }
    expectedHead = digest(receipt);
    prior = receipt;
  });

  if (expectedHead !== expectedTerminalHead) {
    errors.push({
      index: receipts.length,
      message: "terminal receipt does not match the trusted receipt head"
    });
  }
  const terminalReceipt = receipts.at(-1);
  if (
    terminalReceipt === undefined ||
    terminalReceipt.destinationWorkAccordDigest !==
      digest(workAccordValidation.value)
  ) {
    errors.push({
      index: Math.max(0, receipts.length - 1),
      message: "terminal receipt does not bind the supplied Work Accord"
    });
  }

  return errors;
}
