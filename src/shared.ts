/**
 * Shared constants and types used across background.ts and options.ts.
 * This module is the single source of truth for shared definitions.
 */

export const STORAGE_KEY_PROMPTS = 'prompts';
export const STORAGE_KEY_GEMS = 'gems';

export const DEFAULT_PROMPTS: string[] = [
    "翻譯以下文字: ",
    "Translate to English: ",
    "請總結這段文字: "
];

export interface Gem {
    name: string;
    id: string;
}
