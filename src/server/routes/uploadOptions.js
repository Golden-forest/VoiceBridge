import { parseBoolean } from "../config.js";

export function resolveAutoPaste(value, fallback) {
  return parseBoolean(value, fallback);
}
