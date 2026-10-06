"use client";

import { useEffect, useId, useState } from "react";
import { useStore } from "zustand";
import { useServices } from "../../app-services/services-context";
import { createChatController } from "./chat-controller";
import { ChatPanel } from "./ChatPanel";

/**
 * Chat con el agente, plegable en la esquina inferior (cerrado por defecto: no tapa el mapa). Un controlador por montaje del dashboard:
 * al cerrar sesión se desmonta y la última pregunta y respuesta no las ve el siguiente usuario. La pregunta en curso se cancela al
 * enviar otra (lo hace el controlador), al cerrar el chat y al desmontar.
 */
export function ChatDock() {
  const { agentApi } = useServices();
  const [controller] = useState(() => createChatController(agentApi));
  const state = useStore(controller.store);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useEffect(() => () => controller.dispose(), [controller]);

  const toggle = () => {
    if (open) {
      controller.cancel();
      setOpen(false);
      return;
    }
    setOpen(true);
    void controller.refreshHealth();
  };

  return (
    <div className="pointer-events-none fixed bottom-4 left-4 right-4 z-20 flex flex-col items-end gap-2 sm:left-auto">
      {open && (
        <section id={panelId} aria-label="Asistente IA" className="pointer-events-auto w-full rounded-xl border border-line bg-raised p-4 shadow-lg sm:w-96">
          <h2 className="mb-2 font-semibold text-ink">Asistente IA</h2>
          <ChatPanel
            state={state}
            onAsk={(message) => void controller.ask(message)}
            onRetry={() => void controller.retry()}
            onCancel={() => controller.cancel()}
          />
        </section>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        className="pointer-events-auto rounded-full bg-ink px-4 py-2 font-medium text-raised shadow-lg hover:bg-ink/90"
      >
        {open ? "Cerrar asistente" : "Asistente IA"}
      </button>
    </div>
  );
}
