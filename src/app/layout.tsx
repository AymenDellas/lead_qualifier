import type { Metadata } from "next";
import { Inter, Fira_Code } from "next/font/google";
import "./globals.css";
import "./workspace.css";

const inter = Inter({
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
    variable: "--font-inter",
    display: "swap",
});

const firaCode = Fira_Code({
    subsets: ["latin"],
    weight: ["400", "500", "600"],
    variable: "--font-fira-code",
    display: "swap",
});

export const metadata: Metadata = {
    title: "Compel",
    description: "Lead qualification and signal discovery",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" className={`${inter.variable} ${firaCode.variable}`}>
            <body className="font-sans antialiased min-h-screen selection:bg-[var(--signal-dim)]">
                {children}
            </body>
        </html>
    );
}
