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

export function includePropertiesWhen<T extends object, TInclude>(
  include: TInclude,
  createProperties: () => T,
): Partial<T> {
  const properties: Partial<T> = {};
  if (include) Object.assign(properties, createProperties());
  return properties;
}
