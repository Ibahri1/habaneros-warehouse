import type { Metadata } from "next";
import "./globals.css";
import "./mobile-overrides.css";

export const metadata: Metadata = { title:"Habaneros Warehouse Ordering", description:"Internal warehouse ordering and fulfillment for Habaneros stores.", icons:{icon:"/favicon.svg"} };
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
