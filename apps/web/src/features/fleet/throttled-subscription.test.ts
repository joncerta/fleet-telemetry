import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { subscribeThrottled } from "./throttled-subscription";

interface State {
  count: number;
  other: number;
}

const setup = (equals?: (a: number, b: number) => boolean) => {
  const store = createStore<State>()(() => ({ count: 0, other: 0 }));
  const onChange = vi.fn<(value: number) => void>();
  const stop = subscribeThrottled(store, (state) => state.count, 500, onChange, equals);
  // La lectura inicial siempre se entrega (el valor pudo cambiar entre el render y la suscripción).
  expect(onChange).toHaveBeenCalledWith(0);
  onChange.mockClear();
  vi.advanceTimersByTime(500);
  return { store, onChange, stop };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("subscribeThrottled", () => {
  it("el primer cambio sale al momento; los siguientes dentro de 500 ms se juntan en UNA lectura final", () => {
    const { store, onChange } = setup();
    store.setState({ count: 1 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(1);

    for (let i = 2; i <= 11; i += 1) {
      vi.advanceTimersByTime(40);
      store.setState({ count: i });
    }
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(11);
  });

  it("no avisa si el valor elegido no cambió (aunque cambie otra parte del store)", () => {
    const { store, onChange } = setup();
    store.setState({ other: 1 });
    vi.advanceTimersByTime(1_000);
    store.setState({ other: 2 });
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("respeta el comparador (p. ej. igualdad superficial) en vez de la identidad", () => {
    const { store, onChange } = setup(() => true);
    store.setState({ count: 5 });
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("al cancelar no queda ninguna lectura pendiente", () => {
    const { store, onChange, stop } = setup();
    store.setState({ count: 1 });
    store.setState({ count: 2 });
    stop();
    vi.advanceTimersByTime(5_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
