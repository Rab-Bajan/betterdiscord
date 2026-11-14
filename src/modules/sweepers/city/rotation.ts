// Rotation convention of the layout (three.js `rotation.y`): local x maps to world (cos θ, −sin θ),
// local z to (sin θ, cos θ).

/** World direction of the local x axis for rotation `rotY`. */
export const axisU = (rotY: number): readonly [number, number] => [Math.cos(rotY), -Math.sin(rotY)];
/** World direction of the local z axis for rotation `rotY`. */
export const axisV = (rotY: number): readonly [number, number] => [Math.sin(rotY), Math.cos(rotY)];
/** Rotation whose local x axis points along (dx, dz). */
export const rotationAlong = (dx: number, dz: number): number => Math.atan2(-dz, dx);

/** World point at local offset (u, v) from (x, z) in the frame of rotation `rotY`. */
export function offset(x: number, z: number, rotY: number, u: number, v: number): [number, number] {
  const [ux, uz] = axisU(rotY);
  const [vx, vz] = axisV(rotY);
  return [x + u * ux + v * vx, z + u * uz + v * vz];
}
