/** @type {import('next').NextConfig} */
const nextConfig = {
    // Standalone output for Docker/VPS deployment
    output: 'standalone',

    // Allow Node packages in server actions
    serverExternalPackages: [],

    // Disable powered-by header for security
    poweredByHeader: false,

    // Increase server action body size limit for large CSV uploads
    serverActions: {
        bodySizeLimit: '10mb',
    },
};

module.exports = nextConfig;
