/**
 * File decoding — the only part of finance-core with third-party dependencies.
 *
 * Kept behind its own entry point (`finance-core/import`) because `xlsx` is around a
 * megabyte and an app that never imports a bank statement should not ship it. The
 * parsing that happens *after* decoding — column detection, row parsing, screenshot
 * text, de-duplication — is pure and lives in the main entry point.
 */
export * from './files';
