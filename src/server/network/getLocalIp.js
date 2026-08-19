import os from "node:os";

/**
 * 枚举所有可用于 LAN 通信的本机 IPv4 地址（排除回环与链路本地）。
 * 没有 suitable 地址时退回 127.0.0.1。
 */
export function listLocalIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (
        address.family === "IPv4" &&
        !address.internal &&
        !address.address.startsWith("169.254.")
      ) {
        ips.push(address.address);
      }
    }
  }

  return ips.length > 0 ? ips : ["127.0.0.1"];
}

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
