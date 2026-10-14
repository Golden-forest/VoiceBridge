import { AsyncLocalStorage } from "node:async_hooks";

// Clipboard and focus belong to the desktop process, so every transport shares
// one queue. Nested output helpers reuse the current operation instead of
// waiting behind themselves.
export function createDesktopInputQueue() {
  const context = new AsyncLocalStorage();
  let tail = Promise.resolve();
  return function run(operation) {
    if (context.getStore()?.active) return Promise.resolve().then(operation);
    const result = tail.then(() => {
      const scope = { active: true };
      return context.run(scope, async () => {
        try {
          return await operation();
        } finally {
          scope.active = false;
        }
      });
    });
    tail = result.catch(() => {});
    return result;
  };
}

export const runDesktopInputOperation = createDesktopInputQueue();

export function assertInputActive(isActive) {
  if (isActive()) return;
  const error = new Error("电脑输入通道已关闭。");
  error.statusCode = 503;
  error.publicMessage = error.message;
  throw error;
}
