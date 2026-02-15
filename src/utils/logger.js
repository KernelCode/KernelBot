import winston from 'winston';

let logger = null;

export function createLogger(config) {
  const { level, max_file_size } = config.logging;

  logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ level, message, timestamp }) => {
            return `[KernelBot] ${level}: ${message}`;
          }),
        ),
      }),
      new winston.transports.File({
        filename: 'kernel.log',
        maxsize: max_file_size,
        maxFiles: 3,
        format: winston.format.json(),
      }),
    ],
  });

  return logger;
}

export function getLogger() {
  if (!logger) {
    throw new Error('Logger not initialized. Call createLogger(config) first.');
  }
  return logger;
}
