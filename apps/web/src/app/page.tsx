import type { Metadata } from "next";
import { DashboardScreen } from "../features/dashboard/DashboardScreen";

export const metadata: Metadata = { title: "Monitoreo en vivo" };

// El HTML es un cascarón estático: los datos (con la cookie de fleet-api, de otro origen) se piden en el navegador.
export default function DashboardPage() {
  return <DashboardScreen />;
}
