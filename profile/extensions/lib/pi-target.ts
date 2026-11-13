/**
 * The Pi SDK releases choco-pi's contracts, readiness check, and profile marker accept:
 * stable patch releases of one minor line from a minimum (`~1.5.2`, that is
 * `>=1.5.2 <1.6.0`). A new minor release must be reviewed before it is accepted.
 */
const SUPPORTED_MAJOR = 1;
const SUPPORTED_MINOR = 5;
const MINIMUM_PATCH = 2;

/** Oldest accepted release; also the version fixtures use as a supported runtime. */
export const PI_SDK_MINIMUM = `${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}.${MINIMUM_PATCH}`;
/** The npm range every Pi SDK manifest dependency declares. */
export const PI_SDK_RANGE = `~${PI_SDK_MINIMUM}`;
/** Human-readable form of the range for readiness and install messages. */
export const PI_SDK_REQUIREMENT = `>=${PI_SDK_MINIMUM} <${SUPPORTED_MAJOR}.${SUPPORTED_MINOR + 1}.0`;

const STABLE_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Whether a reported Pi version is a stable release inside the supported range. */
export function isSupportedPiVersion(version: string): boolean {
  const match = STABLE_RELEASE.exec(version);
  return (
    match !== null &&
    Number(match[1]) === SUPPORTED_MAJOR &&
    Number(match[2]) === SUPPORTED_MINOR &&
    Number(match[3]) >= MINIMUM_PATCH
  );
}
