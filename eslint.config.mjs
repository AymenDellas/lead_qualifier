import {defineConfig,globalIgnores} from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import tsParser from '@typescript-eslint/parser';
export default defineConfig([
 ...nextVitals,
 {files:['**/*.d.cts'],languageOptions:{parser:tsParser}},
 globalIgnores(['.next/**','out/**','node_modules/**','output/**','data/**','tmp/**','next-env.d.ts']),
]);
