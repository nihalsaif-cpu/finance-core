import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The whole point of this package is that it needs no browser and no native
    // runtime. If a test ever needs one, that test belongs in the app, not here.
    environment: 'node',
  },
});
