import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Lokalmart Importer',
  description: 'Safe Import Cockpit for Odoo Lokalmart',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
