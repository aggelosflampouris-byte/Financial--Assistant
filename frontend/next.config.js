/** @type {import('next').NextConfig} */
const nextConfig = {
  // Strict mode for better React development
  reactStrictMode: true,

  // Transpile plotly and lightweight-charts
  transpilePackages: ['react-plotly.js', 'plotly.js-dist-min'],

  // Environment variable exposure (public vars only)
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080',
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080',
  },

  // Security headers
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://cdn.auth0.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* ws: wss: https://*.auth0.com",
              "img-src 'self' data: https:",
            ].join('; '),
          },
        ],
      },
    ];
  },

  // Package transpilation
  transpilePackages: ['react-plotly.js', 'plotly.js-dist-min'],
};

module.exports = nextConfig;
