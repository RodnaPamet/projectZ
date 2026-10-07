/**
 * Column names that could name or follow a person (#371): what the usage
 * counters must never hold. Shared by the schema guardrail and the integration
 * test that asks the live catalogue.
 */
export const PERSONAL =
  /user|ip|addr|agent|ua$|^ua|session|device|cookie|email|phone|fingerprint|visitor|client|token|referr?er|name/i;
