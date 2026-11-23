const SUPPORTED_MAJOR = 1;
const SUPPORTED_MINOR = 6;
const MINIMUM_PATCH = 0;

export const PI_SDK_MINIMUM = `${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}.${MINIMUM_PATCH}`;
export const PI_SDK_RANGE = `~${PI_SDK_MINIMUM}`;
export const PI_SDK_REQUIREMENT = `>=${PI_SDK_MINIMUM} <${SUPPORTED_MAJOR}.${SUPPORTED_MINOR + 1}.0`;

const STABLE_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isSupportedPiVersion(version: string): boolean {
  const match = STABLE_RELEASE.exec(version);
  return (
    match !== null &&
    Number(match[1]) === SUPPORTED_MAJOR &&
    Number(match[2]) === SUPPORTED_MINOR &&
    Number(match[3]) >= MINIMUM_PATCH
  );
}
