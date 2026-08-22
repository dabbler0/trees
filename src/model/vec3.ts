import type { Vec3 } from './types';
export type { Vec3 } from './types';

/** Minimal Vec3 math kept independent of three.js so the simulation has no
 * rendering dependency at all (only src/render depends on three). */

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len < 1e-12) return [0, 1, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Rotate vector v about unit axis by angle radians (Rodrigues' rotation formula). */
export function rotateAroundAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const k = normalize(axis);
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const kv = cross(k, v);
  const kDotV = dot(k, v);
  return [
    v[0] * cosA + kv[0] * sinA + k[0] * kDotV * (1 - cosA),
    v[1] * cosA + kv[1] * sinA + k[1] * kDotV * (1 - cosA),
    v[2] * cosA + kv[2] * sinA + k[2] * kDotV * (1 - cosA),
  ];
}

/** Any unit vector not parallel to v; useful for building a local frame. */
export function arbitraryOrthogonal(v: Vec3): Vec3 {
  const candidate: Vec3 = Math.abs(v[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  return normalize(cross(v, candidate));
}
