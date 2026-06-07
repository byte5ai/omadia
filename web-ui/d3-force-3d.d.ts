// Minimal ambient declaration for d3-force-3d (force-graph's simulation
// engine). It ships no types and has no @types package; we use `forceCollide`
// for overlap avoidance and `forceX`/`forceY` for weak centering, so loose
// signatures are sufficient.
declare module 'd3-force-3d' {
  interface CollideForce {
    radius(radius: number | ((node: unknown) => number)): CollideForce;
    strength(strength: number): CollideForce;
    (...args: unknown[]): void;
  }
  export function forceCollide(
    radius?: number | ((node: unknown) => number),
  ): CollideForce;

  interface PositioningForce {
    strength(strength: number | ((node: unknown) => number)): PositioningForce;
    x(x: number | ((node: unknown) => number)): PositioningForce;
    y(y: number | ((node: unknown) => number)): PositioningForce;
    (...args: unknown[]): void;
  }
  export function forceX(x?: number | ((node: unknown) => number)): PositioningForce;
  export function forceY(y?: number | ((node: unknown) => number)): PositioningForce;
}
