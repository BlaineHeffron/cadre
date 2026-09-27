export default [
  {
    ignores: ['node_modules/**', '.quality/**', 'coverage/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      complexity: ['error', { max: 0 }],
    },
  },
];
