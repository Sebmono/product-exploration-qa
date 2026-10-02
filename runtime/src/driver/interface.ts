/**
 * Surface Driver interface — the contract Agent QA PoC owns.
 *
 * The agent core only ever speaks this protocol. Engines (Playwright, macOS AX,
 * computer-use vision, fixture replay) are adapters behind it. Nothing outside
 * a driver's own directory may import its underlying engine.
 *
 * Design center (see research/competitive-wedge.md §1): LLM-native observation
 * (token-budgeted snapshot with short-lived refs), act-on-ref, and evidence
 * capture — not scripted element lookup.
 */
import type { TargetSpec } from "../trace/schema.js";

export interface DriverObservation {
  locus: { url?: string | undefined; title?: string | undefined; window?: string | undefined };
  /**
   * Serialized accessibility snapshot, normalized across engines. Interactive
   * elements are tagged with short-lived refs ("ref_12") valid until the next
   * observe().
   */
  a11y: string;
  /** Absolute path of the screenshot captured with this observation, if taken. */
  screenshotPath?: string;
}

export type DriverAction =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref?: string; text: string }
  | { kind: "key"; keys: string }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { kind: "navigate"; url: string }
  | { kind: "wait"; ms: number };

export interface ActResult {
  ok: boolean;
  note?: string;
}

export interface Affordances {
  surface: "web" | "desktop" | "replay";
  a11yTree: boolean;
  screenshots: boolean;
  /** Whether the driver can fall back to vision-grounded coordinates. */
  vision: boolean;
}

export interface SurfaceDriver {
  readonly name: string;
  readonly affordances: Affordances;
  launch(target: TargetSpec): Promise<void>;
  observe(opts?: { screenshot?: boolean }): Promise<DriverObservation>;
  act(action: DriverAction): Promise<ActResult>;
  close(): Promise<void>;
}
