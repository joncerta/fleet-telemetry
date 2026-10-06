import { describe, expect, it } from "vitest";
import { pairingOptions } from "./PairingPanel";

describe("pairingOptions", () => {
  it("separa id y placa y ordena por placa de forma natural", () => {
    const options = pairingOptions(["a1|NRT110", "b2|NRT101", "c3|NRT102"]);
    expect(options).toEqual([
      { vehicleId: "b2", plate: "NRT101" },
      { vehicleId: "c3", plate: "NRT102" },
      { vehicleId: "a1", plate: "NRT110" },
    ]);
  });

  it("una placa con barra vertical no se parte", () => {
    expect(pairingOptions(["a1|AB|1"])).toEqual([{ vehicleId: "a1", plate: "AB|1" }]);
  });
});
