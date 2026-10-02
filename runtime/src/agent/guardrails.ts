/**
 * Guardrail policy v1 (docs/mvp-plan.md 1.5): host allowlist + no-go labels.
 * Checked before every driver.act; violations hard-stop the action (the agent
 * is told why and must plan around it).
 */
import type { DriverAction, DriverObservation } from "../driver/interface.js";

export interface GuardrailPolicy {
  allowedHosts: string[];
  forbiddenLabelPattern: RegExp;
}

export const DEFAULT_FORBIDDEN =
  /delete|remove|destroy|billing|payment|purchase|invite|revoke|deactivate|suspend|sign ?out|log ?out|manage access|transfer/i;

export function defaultPolicy(allowedHosts: string[]): GuardrailPolicy {
  return { allowedHosts, forbiddenLabelPattern: DEFAULT_FORBIDDEN };
}

export interface GuardrailVerdict {
  allowed: boolean;
  reason?: string;
}

function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((a) => host === a || host.endsWith("." + a));
}

/** Look up the a11y line for a ref so we can judge what the agent is about to press. */
export function labelForRef(observation: DriverObservation, ref: string): string {
  const line = observation.a11y.split("\n").find((l) => l.includes(`[${ref}]`));
  return line ?? "";
}

export function checkAction(
  policy: GuardrailPolicy,
  action: DriverAction,
  lastObservation: DriverObservation | undefined,
): GuardrailVerdict {
  if (action.kind === "navigate") {
    let host: string;
    try {
      host = new URL(action.url).hostname;
    } catch {
      return { allowed: false, reason: `unparseable url: ${action.url}` };
    }
    if (!hostAllowed(host, policy.allowedHosts)) {
      return { allowed: false, reason: `host "${host}" is outside the allowlist [${policy.allowedHosts.join(", ")}]` };
    }
    return { allowed: true };
  }
  if (action.kind === "click" && lastObservation) {
    const label = labelForRef(lastObservation, action.ref);
    if (policy.forbiddenLabelPattern.test(label)) {
      return { allowed: false, reason: `target "${label.trim()}" matches the no-go policy` };
    }
  }
  return { allowed: true };
}
