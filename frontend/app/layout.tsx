/**
 * frontend/app/layout.tsx
 * Root layout — provides Auth0 provider, global styles, and semantic HTML shell.
 */
import type { Metadata, Viewport } from 'next';
import { UserProvider } from '@auth0/nextjs-auth0/client';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Financial Assistant — AI Portfolio Manager',
    template: '%s | Financial Assistant',
  },
  description:
    'Enterprise-grade AI-powered financial advisor and portfolio manager. ' +
    'Real-time market data, quantitative analytics, and MiFID II compliant advisory.',
  keywords: ['portfolio management', 'AI advisor', 'quantitative finance', 'MiFID II'],
  robots: { index: false, follow: false },  // Private application — no indexing
};

export const viewport: Viewport = {
  themeColor: '#080b14',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        {/* Preconnect to Google Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
