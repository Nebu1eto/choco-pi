/**
 * Shared helpers for building objects whose optional properties must be
 * absent, not `undefined`, under `exactOptionalPropertyTypes`.
 */

/** Assign the created properties onto `target` only when `include` is truthy. */
export function assignOptionalProperties<T extends object, U extends object, C>(
  target: T,
  include: C,
  createProperties: (included: NonNullable<C>) => U,
): T & Partial<U>;
export function assignOptionalProperties<T extends object, U extends object, C>(
  target: T,
  include: C,
  createProperties: (included: NonNullable<C>) => U,
) {
  return include ? Object.assign(target, createProperties(include)) : target;
}

/** Return the created properties when `include` is truthy, else an empty object to spread. */
export function includePropertiesWhen<T extends object, TInclude>(
  include: TInclude,
  createProperties: () => T,
): Partial<T> {
  const properties: Partial<T> = {};
  if (include) Object.assign(properties, createProperties());
  return properties;
}
