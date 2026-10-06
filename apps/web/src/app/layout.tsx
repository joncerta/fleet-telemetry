import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppServicesProvider } from "../app-services/services-context";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Fleet Telemetry", template: "%s · Fleet Telemetry" },
  description: "Monitoreo de la flota en vivo.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <AppServicesProvider>{children}</AppServicesProvider>
      </body>
    </html>
  );
}
