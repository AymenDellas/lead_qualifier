import type { Metadata } from "next";
import { Outfit, Fira_Code } from "next/font/google";
import "./globals.css";

const outfit = Outfit({ 
    subsets: ["latin"],
    variable: '--font-outfit',
    display: 'swap',
});

const firaCode = Fira_Code({
    subsets: ['latin'],
    variable: '--font-fira-code',
    display: 'swap',
});

export const metadata: Metadata = {
    title: "Revlane Signal Engine",
    description: "High-end Lead Qualification Dashboard",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" className="scroll-smooth">
            <body className={`bg-background text-text ${outfit.variable} ${firaCode.variable} ${outfit.className} antialiased relative min-h-screen selection:bg-accent selection:text-black`}>
                <div className="fixed inset-0 z-0 pointer-events-none">
                    <div className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.07)_1px,transparent_1px)] bg-[size:16px_16px] [mask-image:radial-gradient(ellipse_50%_50%_at_50%_50%,#000_80%,transparent_100%)]"></div>
                </div>
                <div className="relative z-10">
                    {children}
                </div>
            </body>
        </html>
    );
}
