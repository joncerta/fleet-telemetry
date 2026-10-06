import { issueDeviceToken, parseVehicleArg } from "../device-token.js";
import { runLocalCommand } from "./run.js";

// `pnpm device:token -- --vehicle <id|placa>`: solo en local.
// El token va ÚNICAMENTE a stdout (para capturarlo o copiarlo) y no pasa por el logger. Todo lo demás va a stderr
// o al logger, y sin la placa (dato personal).
await runLocalCommand("device:token", async (pool, logger) => {
  const vehicle = parseVehicleArg(process.argv.slice(2));
  const issued = await issueDeviceToken(pool, vehicle);

  logger.info(
    { deviceId: issued.deviceId, vehicleId: issued.vehicleId, revokedDevices: issued.revokedDevices },
    issued.revokedDevices > 0 ? "Token rotado: se revocó el dispositivo anterior" : "Dispositivo creado",
  );
  process.stderr.write("Guarda el token ahora: no se vuelve a mostrar (en la base solo queda su sha256).\n");
  process.stdout.write(`${issued.token}\n`);
});
