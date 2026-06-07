// Minimal ambient declaration for d3-force-3d (force-graph's simulation
// engine). It ships no types and has no @types package; we only use
// `forceCollide` to add a collision force to the running simulation, so a
// loose signature is sufficient.
declare module 'd3-force-3d' {
  interface CollideForce {
    radius(radius: number | ((node: unknown) => number)): CollideForce;
    strength(strength: number): CollideForce;
    (...args: unknown[]): void;
  }
  export function forceCollide(
    radius?: number | ((node: unknown) => number),
  ): CollideForce;
}
