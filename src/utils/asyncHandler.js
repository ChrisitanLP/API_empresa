// utils/asyncHandler.js
const logger = require('../conf/logger');

const asyncHandler = (fn) => async (req, res, next) => {
    try {
        await fn(req, res, next);
    } catch (error) {
        // Manejar cuando error es undefined o null
        if (!error) {
            logger.error('Undefined error caught in async handler');
            return res.status(500).json({ 
                success: false, 
                error: 'An unknown error occurred' 
            });
        }

        // Obtener información del error de forma segura
        const errorName = error.name || 'UnknownError';
        const errorMessage = error.message || 'An error occurred';
        const errorStack = error.stack || 'No stack trace available';

        logger.error(`Error in async handler: ${errorName} - ${errorMessage}`, { 
            stack: errorStack,
            url: req.originalUrl,
            method: req.method
        });

        // Mapeo de errores conocidos
        const errorResponses = {
            ValidationError: { status: 400, message: errorMessage },
            NotFoundError: { status: 404, message: errorMessage },
            UnknownError: { status: 500, message: errorMessage }
        };

        const { status, message } = errorResponses[errorName] || { 
            status: 500, 
            message: 'Internal server error' 
        };
        
        // Asegurar que la respuesta no se ha enviado ya
        if (!res.headersSent) {
            return res.status(status).json({ success: false, error: message });
        }
    }
};

class AppError extends Error {
    constructor(name, message, statusCode) {
        super(message);
        this.name = name;
        this.statusCode = statusCode;
        Error.captureStackTrace(this, this.constructor);
    }
}

module.exports = {
    asyncHandler,
    ValidationError: class extends AppError {
        constructor(message) {
            super('ValidationError', message, 400);
        }
    },
    NotFoundError: class extends AppError {
        constructor(message) {
            super('NotFoundError', message, 404);
        }
    }
};