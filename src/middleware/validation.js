// middleware/validation.js
const { validationResult, param, body, query } = require('express-validator');
const logger = require('../conf/logger');

// Constantes para mensajes de error comunes
const ERROR_MESSAGES = {
    REQUIRED: 'Campo obligatorio',
    STRING: 'Debe ser una cadena de texto',
    BOOLEAN: 'Debe ser un valor booleano',
    POSITIVE_INT: 'Debe ser un número entero positivo',
    VALID_DATE: 'Debe ser una fecha válida',
    BASE64: 'Debe ser una cadena en formato Base64',
    PHONE: 'Debe ser un número de teléfono válido',
};


// Validaciones comunes reutilizables
const commonValidations = {
    clientId: body('clientId')
        .trim()
        
        .isString().withMessage(ERROR_MESSAGES.STRING),

    phoneNumber: (field) => body(field)
        .trim()
        
        .isString().withMessage(ERROR_MESSAGES.STRING),

    isGroup: body('isGroup')
        .isBoolean().withMessage(ERROR_MESSAGES.BOOLEAN)
        ,

    pagination: [
        query('page')
            .optional()
            .isInt({ min: 1 })
            .withMessage(ERROR_MESSAGES.POSITIVE_INT),
        query('limit')
            .optional()
            .isInt({ min: 1, max: 100 })
            .withMessage('Debe ser un número entre 1 y 100'),
    ],

    base64Content: (field) => body(field)
        .isString().withMessage(ERROR_MESSAGES.STRING)
        
        .matches(/^data:([A-Za-z-+/]+);base64,(.+)$/)
        .withMessage('Formato Base64 inválido'),
};

// Sanitización común para todos los campos
const sanitizeRequest = (req) => {
    // Sanitizar body
    if (req.body) {
        Object.keys(req.body).forEach(key => {
            if (typeof req.body[key] === 'string') {
                req.body[key] = req.body[key].trim();
            }
        });
    }

    // Sanitizar query params
    if (req.query) {
        Object.keys(req.query).forEach(key => {
            if (typeof req.query[key] === 'string') {
                req.query[key] = req.query[key].trim();
            }
        });
    }
};


// Middleware de validación mejorado
const validateRequest = (routeName) => async (req, res, next) => {
    try {
        // Aplicar sanitización
        sanitizeRequest(req);

        // Obtener y ejecutar validaciones
        const validations = getValidationRules(routeName);
        if (!validations) {
            logger.warn(`No validation rules found for route: ${routeName}`);
            return next();
        }

        await Promise.all(validations.map(validation => validation.run(req)));

        // Verificar errores
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            logger.debug(`Validation failed for ${routeName}`, { 
                errors: errors.array(),
                body: req.body,
                query: req.query,
                params: req.params
            });

            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array().map(err => ({
                    field: err.param,
                    message: err.msg,
                    value: err.value
                }))
            });
        }

        next();
    } catch (error) {
        logger.error(`Validation error in ${routeName}`, {
            error: error.message,
            stack: error.stack,
            routeName
        });

        res.status(500).json({
            success: false,
            message: 'Internal server error during validation'
        });
    }
};

// Reglas de validación organizadas por dominio
const validationRules = {
    // Client Management
    getQrCode: [
        param('number').trim()
    ],

    addClient: [
        commonValidations.phoneNumber('number')
    ],

    removeClient: [
        commonValidations.phoneNumber('number')
    ],

    getClientStatus: [
        commonValidations.phoneNumber('number')
    ],

    getConnectionStatus: [
        commonValidations.phoneNumber('number')
    ],

    // Contact Management
    saveContact: [
        commonValidations.phoneNumber('clientNumber'),
        commonValidations.phoneNumber('contactNumber'),
        body('contactName')
            .trim()
            
            .isLength({ min: 2, max: 50 }).withMessage('Longitud inválida')
    ],

    getGroupChats: [
        param('clientId')
            .trim()
            .notEmpty().withMessage(ERROR_MESSAGES.REQUIRED)
            .isString().withMessage(ERROR_MESSAGES.STRING)
    ],

    getContacts: commonValidations.pagination,

    // Chat Management
    getChats: commonValidations.pagination,

    getUnreadChats: commonValidations.pagination,

    markChatAsRead: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        commonValidations.isGroup
    ],

    // Message Management
    sendMessage: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        body('mensaje')
            .trim()
            
            .isLength({ max: 4096 }).withMessage('Mensaje demasiado largo')
    ],

    sendAudio: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
    ],

    // Media Messages
    sendMessageOrFile: [
        commonValidations.clientId,
        body('chatId').trim(),
        body('message').optional().isString(),
        body('filePath').optional().isString()
    ],

    sendMessageOrFile2: [
        commonValidations.clientId,
        body('chatId').trim(),
        body('message').optional().isString(),
        body('fileName').optional().isString(),
        body('fileContent').optional().matches(/^data:([A-Za-z-+/]+);base64,(.+)$/)
            .withMessage(ERROR_MESSAGES.BASE64),
        commonValidations.isGroup
    ],
    
    sendSticker: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        body('stickerPath').trim(),
        commonValidations.isGroup
    ],

    sendImage: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        body('imagePath').trim(),
        commonValidations.isGroup
    ],
    
    sendMessageProduct: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        body('mensaje').trim(),
        commonValidations.base64Content('imagen')
    ],

    sendMessageProductGroup: [
        commonValidations.clientId,
        body('groupId').trim(),
        body('mensaje').trim(),
        commonValidations.base64Content('imagen')
    ],

    forwardMessage: [
        commonValidations.clientId,
        commonValidations.phoneNumber('fromTel'),
        commonValidations.phoneNumber('toTel'),
        body('messageIds')
            .isArray({ min: 1 })
            .withMessage('messageIds debe ser un array con al menos un elemento'),
        body('messageIds.*')
            .isString()
            .trim()
            .notEmpty()
            .withMessage('Cada ID de mensaje debe ser una cadena válida'),
        body('isGroupFrom')
            .isBoolean()
            .withMessage('isGroupFrom debe ser un valor booleano'),
        body('isGroupTo')
            .isBoolean()
            .withMessage('isGroupTo debe ser un valor booleano')
    ],

    // Mensajes
    deleteMessage: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        body('messageId').isString(),
        commonValidations.isGroup
    ],

    markMessageAsImportant: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        body('messageId').isString(),
        commonValidations.isGroup
    ],

    unmarkMessageAsImportant: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        body('messageId').isString(),
        commonValidations.isGroup
    ],

    editMessage: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        body('messageId').isString(),
        body('newContent').isString(),
        commonValidations.isGroup
    ],

    // Gestión de chats
    muteChat: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        commonValidations.isGroup,
        body('unmuteDate').optional().isISO8601().withMessage(ERROR_MESSAGES.VALID_DATE)
    ],

    pinChat: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        commonValidations.isGroup
    ],

    unpinChat: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        commonValidations.isGroup
    ],

    // Mensajes con menciones
    sendMessageWithMention: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        commonValidations.isGroup,
        commonValidations.phoneNumber('mentionTel'),
        body('message').isString()
    ], 

    markChatAsUnread: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        commonValidations.isGroup
    ],

    getChatMessages: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
    ],

    getGroupChatMessages: [
        param('number').trim(),
        param('groupId').trim()
    ],

    sendGroupMessage: [
        commonValidations.clientId,
        body('groupId').trim(),
        body('mensaje')
            .trim()
            
            .isLength({ max: 4096 }).withMessage('Mensaje demasiado largo')
    ],

    replyToMessage: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        body('messageId').trim(),
        body('reply')
            .trim()
            
            .isLength({ max: 4096 }).withMessage('Respuesta demasiado larga'),
        commonValidations.isGroup
    ],

    getMessageInfo: [
        commonValidations.clientId,
        commonValidations.phoneNumber('tel'),
        body('messageId').trim(),
        commonValidations.isGroup
    ],

    // Status Updates
    listenToStatusUpdates: [commonValidations.phoneNumber('number')],
}

const getValidationRules = (routeName) => validationRules[routeName] || null;

module.exports = { validateRequest };