export function safeDeliveryErrorSummary(detail: unknown): string | undefined {
  if (typeof detail !== "string") return undefined;
  const httpStatus = /^(?:Retry budget exhausted after \d+ attempts: )?(?:PushPlus )?HTTP ([1-5]\d{2})(?::|$)/u.exec(detail);
  if (httpStatus) return `HTTP ${httpStatus[1]}`;
  if (detail.startsWith("Retry budget exhausted")) return "Retry budget exhausted";
  if (detail === "Delivery TTL expired") return detail;
  return "Driver error details withheld";
}
