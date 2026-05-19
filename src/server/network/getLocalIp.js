import os from "node:os";

export function getLocalIp() {
  const interfaces = os.networkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (
        address.family === "IPv4" &&
        !address.internal &&
        !address.address.startsWith("169.254.")
      ) {
        return address.address;
      }
    }
  }

  return "127.0.0.1";
}
