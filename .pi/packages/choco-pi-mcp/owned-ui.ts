import { isFunctionValue, isObjectValue } from "./protocol-values.ts";

/**
 * The slice of a runtime owner the UI fence needs.
 *
 * Kept in its own module so it loads under Node's strip-only TypeScript mode:
 * the runtime-owner module reaches utility imports that mode cannot resolve,
 * and this fence is worth testing directly.
 */
export interface OwnedUiOwner {
  isActive(): boolean;
}

/**
 * Fence session-bound UI calls after the owning extension runtime stops. The
 * proxy preserves the wrapped value's interface, so the caller's UI type comes
 * back unchanged.
 */
export function createOwnedUi<Ui extends object>(ui: Ui, owner: OwnedUiOwner): Ui {
  const proxies = new WeakMap<object, object>();

  const wrap = <BoundaryValue>(value: BoundaryValue): BoundaryValue => {
    if ((!isObjectValue(value) || value === null) && !isFunctionValue(value)) {
      return value;
    }
    // SAFETY: Adjacent validation or the typed SDK establishes the asserted protocol value shape at this compatibility boundary.
    const object = value as object;
    const existing = proxies.get(object);
    if (existing) {
      // SAFETY: The cached proxy preserves the runtime interface of the original value.
      return existing as BoundaryValue;
    }

    const proxy = new Proxy(object, {
      get(target, property, receiver) {
        let descriptorOwner: object | null = target;
        let descriptor: PropertyDescriptor | undefined;
        while (descriptorOwner !== null && descriptor === undefined) {
          descriptor = Object.getOwnPropertyDescriptor(descriptorOwner, property);
          descriptorOwner = Object.getPrototypeOf(descriptorOwner);
        }
        // A getter is only invoked while the owner is active; a fenced runtime
        // must not read live state to answer a property it will discard.
        const member =
          descriptor && "value" in descriptor
            ? descriptor.value
            : owner.isActive()
              ? descriptor?.get?.call(receiver)
              : undefined;

        if (isFunctionValue(member)) {
          // Methods stay callable after deactivation and no-op instead. A
          // chain like `ui.theme.fg(...)` can otherwise fetch `theme` while
          // active and reach `.fg` after the owner stopped, turning the fence
          // into a mid-expression TypeError inside a tool call.
          return (...args: unknown[]) => {
            if (!owner.isActive()) return undefined;

            return member.apply(target, args);
          };
        }
        return owner.isActive() ? wrap(member) : undefined;
      },
    });
    proxies.set(object, proxy);

    // SAFETY: Proxy traps only fence access; they preserve the wrapped value's public interface.
    return proxy as BoundaryValue;
  };
  return wrap(ui);
}
