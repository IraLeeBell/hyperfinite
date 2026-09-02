export function boundedDeliverySummary(
  acceptedCriteria: readonly string[]
): string {
  return acceptedCriteria.join(", ");
}
