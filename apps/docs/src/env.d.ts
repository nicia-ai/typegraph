/// <reference types="astro/client" />

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- keep the Readonly wrapper for consistent immutability semantics
interface ImportMetaEnv extends Readonly<{
  PUBLIC_POSTHOG_KEY: string;
  PUBLIC_POSTHOG_HOST?: string;
  DEV: boolean;
}> {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- keep the Readonly wrapper for consistent immutability semantics
interface ImportMeta extends Readonly<{ env: ImportMetaEnv }> {}
