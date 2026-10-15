// Test-only preload for PGlite's cleartext PostgreSQL socket. Production keeps
// the SSL configuration in src/lib/pg_setup.ts unchanged.
const pg = require('pg');
const OriginalPool = pg.Pool;
class CleartextPool extends OriginalPool {
    constructor(config = {}) {
        super({ ...config, ssl: false });
    }
}
Object.defineProperty(pg, 'Pool', { configurable: true, enumerable: true, value: CleartextPool });
