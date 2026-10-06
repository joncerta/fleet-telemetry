// Orden importante: la tarea de ubicación se define a nivel de módulo ANTES de registrar la app, para que exista cuando
// Android despierta el proceso en segundo plano sin pasar por ningún componente.
import "./src/background/location-task";

import { registerRootComponent } from "expo";
import { App } from "./src/App";

registerRootComponent(App);
