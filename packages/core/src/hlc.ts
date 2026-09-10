/**
 * Hybrid logical clock (HLC), the conflict clock for last-writer-wins fields.
 *
 * Serialized as a fixed-width string that sorts lexicographically by
 * (wall ms, counter, device): "2026-09-10T12:34:56.789Z-0003-a1b2c3d4".
 * Ops carry one; every mergeable field stores the HLC of its last write.
 */

export interface HlcParts {
  wall: number; // epoch ms
  counter: number; // 0..65535
  device: string; // 8 lowercase hex/alnum chars, tie-breaker
}

const HLC_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-([0-9a-f]{4})-([0-9a-z]{8})$/;

/** Max tolerated skew of a remote clock ahead of ours (Actual Budget's rule). */
export const HLC_MAX_DRIFT_MS = 60_000;

export class HlcDriftError extends Error {
  constructor(
    public readonly remote: string,
    public readonly localWall: number,
  ) {
    super(
      `HLC drift: remote clock ${remote} is more than ${HLC_MAX_DRIFT_MS}ms ahead of local ${new Date(localWall).toISOString()}`,
    );
    this.name = "HlcDriftError";
  }
}

export function formatHlc(p: HlcParts): string {
  return `${new Date(p.wall).toISOString()}-${p.counter.toString(16).padStart(4, "0")}-${p.device}`;
}

export function parseHlc(s: string): HlcParts {
  const m = HLC_RE.exec(s);
  if (!m) throw new Error(`invalid HLC: ${s}`);
  return {
    wall: Date.parse(m[1] as string),
    counter: Number.parseInt(m[2] as string, 16),
    device: m[3] as string,
  };
}

export function isHlc(s: string): boolean {
  return HLC_RE.test(s);
}

/** Lexicographic comparison is the HLC order. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Hlc {
  private wall: number;
  private counter: number;

  constructor(
    public readonly device: string,
    last?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^[0-9a-z]{8}$/.test(device)) throw new Error(`invalid device id: ${device}`);
    const p = last ? parseHlc(last) : { wall: 0, counter: 0 };
    this.wall = p.wall;
    this.counter = p.counter;
  }

  /** Current state as a string (does not advance). */
  get last(): string {
    return formatHlc({ wall: this.wall, counter: this.counter, device: this.device });
  }

  /** Generate a timestamp for a local event. */
  next(): string {
    const phys = this.now();
    if (phys > this.wall) {
      this.wall = phys;
      this.counter = 0;
    } else {
      this.counter++;
      if (this.counter > 0xffff) {
        this.wall++;
        this.counter = 0;
      }
    }
    return this.last;
  }

  /** Absorb a remote timestamp so our next() is greater than anything we have seen. */
  receive(remote: string): void {
    const r = parseHlc(remote);
    const phys = this.now();
    if (r.wall > phys + HLC_MAX_DRIFT_MS) throw new HlcDriftError(remote, phys);
    if (r.wall > this.wall) {
      this.wall = r.wall;
      this.counter = r.counter;
    } else if (r.wall === this.wall && r.counter > this.counter) {
      this.counter = r.counter;
    }
    if (phys > this.wall) {
      this.wall = phys;
      this.counter = 0;
    }
  }
}
