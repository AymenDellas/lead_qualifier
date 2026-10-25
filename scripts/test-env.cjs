'use strict';
// Initialize CLI tests the same way as the local worker, before pg_setup imports.
// Never print configuration values or modify environment files.
require('@next/env').loadEnvConfig(require('node:path').resolve(__dirname,'..'));
