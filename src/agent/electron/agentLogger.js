import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LOG_FILES = 7;

export function createAgentLogger({ userDataPath, now = () => new Date() }) {
  const logDir = join(userDataPath, 'logs');
  try {
    mkdirSync(logDir, { recursive: true });
    pruneOldLogs(logDir);
  } catch {
    // Logging must never break the agent; fall back to no-op.
    return noopLogger;
  }

  const dateKey = () => {
    const d = now();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}${mm}${dd}`;
  };

  return {
    log(event, detail = '') {
      try {
        const ts = now().toISOString();
        const line = `${ts} ${event}${detail ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}\n`;
        appendFileSync(join(logDir, `agent-${dateKey()}.log`), line);
      } catch {
        // Disk full / permissions — drop silently.
      }
    },
    readRecentLines(count = 200) {
      try {
        const files = readdirSync(logDir).filter((f) => f.startsWith('agent-')).sort().reverse();
        if (!files.length) return '';
        const content = readFileSync(join(logDir, files[0]), 'utf8');
        return content.split('\n').slice(-count).join('\n');
      } catch {
        return '';
      }
    }
  };
}

function pruneOldLogs(logDir) {
  const files = readdirSync(logDir)
    .filter((f) => /^agent-\d{8}\.log$/.test(f))
    .sort()
    .reverse();
  for (const stale of files.slice(MAX_LOG_FILES)) {
    try {
      rmSync(join(logDir, stale));
    } catch {
      // Best effort.
    }
  }
}

const noopLogger = {
  log() {},
  readRecentLines() {
    return '';
  }
};

export const __testHooks = { pruneOldLogs };
