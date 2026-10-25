/** @type {import('next').NextConfig} */
const nextConfig = {
    // Standalone output for Docker/VPS deployment
    output: 'standalone',
    outputFileTracingRoot: __dirname,
    turbopack: { root: __dirname },

    // Allow Node packages in server actions
    serverExternalPackages: ['better-sqlite3', 'imapflow', '@qwen-code/qwen-code'],

    outputFileTracingIncludes: {
        '/api/copy-studio/*': ['./node_modules/@qwen-code/qwen-code/**/*'],
    },

    // Local sessions/evidence are runtime state, never deployment assets. Broad
    // dynamic filesystem paths in Finder/Create must not package this PC's data.
    outputFileTracingExcludes: {
        '/*': [
            './.browser-profiles*/**/*', './data/**/*', './progress/**/*',
            './queue*/**/*', './case-study-queue/**/*', './case-study-results/**/*',
            './scrape-results/**/*', './api-data/**/*', './backups/**/*',
            './output/**/*', './tmp/**/*', './.git/**/*', './.env*',
        ],
    },

    // Disable powered-by header for security
    poweredByHeader: false,

    // Increase server action body size limit for large CSV uploads
    experimental: {
        serverActions: {
            bodySizeLimit: '10mb',
        },
    },

};

module.exports = nextConfig;
