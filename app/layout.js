// app/layout.js
import './globals.css';

export const metadata = {
    title: 'WalleTool',
    description: 'Solana Vanity Wallet Generator + Live Dashboard',
};

export default function RootLayout({ children }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}