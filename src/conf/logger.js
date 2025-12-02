// logger.js
const winston = require('winston');
const path = require('path');

const logFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, stack }) => {
        return `${timestamp} [${level.toUpperCase()}]: ${message}${stack ? `\nStack: ${stack}` : ''}`;
    })
);

const logger = winston.createLogger({
    level: 'info',
    format: logFormat,
    transports: [
        new winston.transports.File({ filename: path.join(__dirname, 'logs', 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join(__dirname, 'logs', 'combined.log') })
    ]
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    }));
}

module.exports = logger;