// Operational deadlines and confirmation windows must fit their real timer
// consumers. Reject unsupported host policy before opening the action store.
export const MAX_ACTION_TIMEOUT_MS = 120000;
export const MAX_CONFIRMATION_TTL_MS = 3600000;
export function validActionDurations(policy) {
  const timeout = policy && Object.hasOwn(policy, 'timeoutMs') ? policy.timeoutMs : 10000;
  return Number.isSafeInteger(policy?.confirmationTtlMs)
    && policy.confirmationTtlMs > 0 && policy.confirmationTtlMs <= MAX_CONFIRMATION_TTL_MS
    && Number.isSafeInteger(timeout) && timeout > 0 && timeout <= MAX_ACTION_TIMEOUT_MS;
}
