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
