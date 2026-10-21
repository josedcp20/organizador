import rootConfig from '../eslint.config.js';

// Hereda la config raiz; en TS el typecheck ya valida los globals (workers-types / node).
export default [
  ...rootConfig,
  {
    files: ['**/*.ts'],
    rules: { 'no-undef': 'off' },
  },
];
