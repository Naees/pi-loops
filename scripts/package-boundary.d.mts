export const FORBIDDEN_PACKAGE_PREFIXES: readonly string[];
export const REQUIRED_PACKAGE_PATHS: readonly string[];

export type PackageFile = string | { path?: unknown } | null | undefined;

export function packageFilePaths(files: readonly PackageFile[]): string[];
export function findForbiddenPackagePaths(files: readonly PackageFile[]): string[];
export function findMissingPackagePaths(files: readonly PackageFile[]): string[];
