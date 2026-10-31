import { pino, type Logger } from 'pino';

export type { Logger };

/** Structured JSON logs with secret redaction (ARCHITECTURE §17.6). */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'studysync-server' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
      censor: '[redacted]',
    },
  });
}
