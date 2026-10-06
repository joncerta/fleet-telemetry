import type { UserListItem } from "@fleet/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { FleetApi } from "../../lib/api/fleet-api";
import { failed, idle, loading, ready, type Loadable } from "../../lib/loadable";
import { listErrorMessage } from "../pairing/pairing-errors";

/** Tope de usuarios que pide el panel (el máximo del contrato). */
export const USERS_LIMIT = 500;

const byName = new Intl.Collator("es-CO", { sensitivity: "base" });

/** Usuarios ordenados por nombre (y por correo si el nombre empata). */
export function sortUsers(items: readonly UserListItem[]): UserListItem[] {
  return [...items].sort((a, b) => byName.compare(a.name, b.name) || byName.compare(a.email, b.email));
}

export interface UsersState {
  readonly users: Loadable<UserListItem[]>;
}

export interface UsersController {
  readonly store: StoreApi<UsersState>;
  /** (Re)carga la lista. Si falla, conserva la anterior con su hora y el error. */
  load(): Promise<void>;
  dispose(): void;
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/** Lista de solo lectura de los usuarios del tenant. Nombre y correo son datos personales: solo se muestran, nunca se registran. */
export function createUsersController(api: Pick<FleetApi, "listUsers">, now: () => number = Date.now): UsersController {
  const store = createStore<UsersState>()(() => ({ users: idle() }));
  let current: AbortController | null = null;
  return {
    store,
    async load() {
      current?.abort();
      const request = new AbortController();
      current = request;
      store.setState((state) => ({ users: loading(state.users) }));
      try {
        const response = await api.listUsers(USERS_LIMIT, request.signal);
        if (current !== request) return;
        store.setState({ users: ready(sortUsers(response.items), now()) });
      } catch (error) {
        if (current !== request || isAbort(error)) return;
        store.setState((state) => ({ users: failed(state.users, listErrorMessage("usuarios", error)) }));
      }
    },
    dispose() {
      current?.abort();
      current = null;
    },
  };
}
