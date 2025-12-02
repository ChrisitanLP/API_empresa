const express = require('express');
const router = express.Router();
const controller = require('../controllers/controllers');
const { validateRequest } = require('../middleware/validation');
const { asyncHandler } = require('../utils/asyncHandler');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const logger = require('../conf/logger');

// Configuración de seguridad
router.use(helmet());

// Limiter configurations
const apiLimiter = rateLimit({
    windowMs: 30 * 60 * 1000,
    max: 500,
    message: 'Too many requests from this IP, please try again later.'
});

// CORS configuration
const corsOptions = {
    origin: process.env.NODE_ENV === 'production' 
        ? process.env.ALLOWED_ORIGINS?.split(',') || '*'
        : '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'ngrok-skip-browser-warning',
        'User-Agent'
    ],
    credentials: true,
    maxAge: 86400
};

router.use(cors(corsOptions));
router.use(apiLimiter);

// 🔹 NUEVO: Wrapper simple para rutas de lectura (sin asyncHandler)
const simpleHandler = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (error) {
        const errorMessage = error?.message || 'Unknown error';
        logger.error(`Error in ${req.originalUrl}:`, {
            message: errorMessage,
            stack: error?.stack || 'No stack trace',
            method: req.method
        });
        
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: errorMessage
            });
        }
    }
};

// Route groups for better organization
const routes = {
    monitoring: [
        { 
            path: '/health/metrics', 
            method: 'get', 
            handler: 'getHealthMetrics',
            useAsync: true, // 🔹 Usa asyncHandler
            rateLimit: { windowMs: 60000, max: 30 }
        },
        { 
            path: '/health/metrics/:number', 
            method: 'get', 
            handler: 'getHealthMetrics',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 30 }
        },
        { 
            path: '/client/state/:number', 
            method: 'get', 
            handler: 'getClientStateInfo',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 20 }
        },
        { 
            path: '/client/reconnect', 
            method: 'post', 
            handler: 'forceReconnect',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 5 }
        },
        { 
            path: '/reconnection/status', 
            method: 'get', 
            handler: 'getReconnectionStatus',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 20 }
        },
        {
            path: '/operational/:number',
            method: 'get',
            handler: 'checkClientOperational',
            useAsync: true,
            rateLimit: { windowMs: 10000, max: 30 }
        }
    ],
    clients: [
        { 
            path: '/qr/:number', 
            method: 'get', 
            handler: 'getQrCode',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 5 }
        },
        { 
            path: '/status_connection/:number', 
            method: 'get', 
            handler: 'getConnectionStatus',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 10 }
        },
        { 
            path: '/addClient', 
            method: 'post', 
            handler: 'addClient',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 5 }
        },
        { 
            path: '/status/:number', 
            method: 'get', 
            handler: 'getClientStatus',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 5 }
        },
        { 
            path: '/removeClient', 
            method: 'post', 
            handler: 'removeClient',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 5 }
        }
    ],
    messaging: [
        { 
            path: '/sendMessage', 
            method: 'post', 
            handler: 'sendMessage',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 30 }
        },
        { 
            path: '/sendGroupMessage', 
            method: 'post', 
            handler: 'sendGroupMessage',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 30 }
        },
        { 
            path: '/sendMention', 
            method: 'post', 
            handler: 'sendMessageWithMention',
            useAsync: true
        }
    ],
    mediaMessages: [
        { 
            path: '/sendMessageorFile', 
            method: 'post', 
            handler: 'sendMessageOrFile',
            useAsync: true
        },
        { 
            path: '/sendSticker', 
            method: 'post', 
            handler: 'sendSticker',
            useAsync: true
        },
        { 
            path: '/sendImage', 
            method: 'post', 
            handler: 'sendImage',
            useAsync: true
        },
        { 
            path: '/sendAudio',  
            method: 'post', 
            handler: 'sendAudio',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 20 }
        },
        { 
            path: '/sendMessageProducts', 
            method: 'post', 
            handler: 'sendMessageProduct',
            useAsync: true
        },
        { 
            path: '/sendGroupProducts', 
            method: 'post', 
            handler: 'sendMessageProductGroup',
            useAsync: true
        }
    ],
    chats: [
        { 
            path: '/chats', 
            method: 'get', 
            handler: 'getChats',
            useAsync: false // 🔹 NO usa asyncHandler
        },
        { 
            path: '/unreadChats', 
            method: 'get', 
            handler: 'getUnreadChats',
            useAsync: false // 🔹 NO usa asyncHandler
        },
        { 
            path: '/groups/:clientId', 
            method: 'get', 
            handler: 'getGroupChats',
            useAsync: false, // 🔹 NO usa asyncHandler
            rateLimit: { windowMs: 60000, max: 20 }
        },
        { 
            path: '/markChatRead/:clientId/:tel/:isGroup', 
            method: 'post', 
            handler: 'markChatAsRead',
            useAsync: true
        },
        { 
            path: '/markChatAsUnread', 
            method: 'post', 
            handler: 'markChatAsUnread',
            useAsync: true
        },
        { 
            path: '/pinChat', 
            method: 'post', 
            handler: 'pinChat',
            useAsync: true
        },
        { 
            path: '/unpinChat', 
            method: 'post', 
            handler: 'unpinChat',
            useAsync: true
        },
        { 
            path: '/muteChat', 
            method: 'post', 
            handler: 'muteChat',
            useAsync: true
        }
    ],
    contacts: [
        { 
            path: '/getContacts', 
            method: 'get', 
            handler: 'getContacts',
            useAsync: false // 🔹 NO usa asyncHandler
        },
        { 
            path: '/saveContact', 
            method: 'post', 
            handler: 'saveContact',
            useAsync: true
        }
    ],
    messages: [
        { 
            path: '/chatMessages/:clientId/:tel', 
            method: 'get', 
            handler: 'getChatMessages',
            useAsync: true
        },
        { 
            path: '/chatGroupMessages/:number/:groupId', 
            method: 'get', 
            handler: 'getGroupChatMessages',
            useAsync: true
        },
        { 
            path: '/forwardMessage', 
            method: 'post', 
            handler: 'forwardMessage',
            useAsync: true
        },
        { 
            path: '/replyMessage', 
            method: 'post', 
            handler: 'replyToMessage',
            useAsync: true
        },
        { 
            path: '/getMessageInfo', 
            method: 'get', 
            handler: 'getMessageInfo',
            useAsync: true
        },
        { 
            path: '/deleteMessage', 
            method: 'delete', 
            handler: 'deleteMessage',
            useAsync: true
        },
        { 
            path: '/editMessage', 
            method: 'post', 
            handler: 'editMessage',
            useAsync: true
        },
        { 
            path: '/markMessageAsImportant', 
            method: 'post', 
            handler: 'markMessageAsImportant',
            useAsync: true
        },
        { 
            path: '/unmarkMessageImportant', 
            method: 'post', 
            handler: 'unmarkMessageAsImportant',
            useAsync: true
        }
    ],
    account: [
        { 
            path: '/authenticated-accounts', 
            method: 'get', 
            handler: 'getAllAuthenticatedAccountsInfo',
            useAsync: true
        }
    ],
    media: [
        { 
            path: '/media/status/:messageId', 
            method: 'get', 
            handler: 'getMediaStatus',
            useAsync: true,
            rateLimit: { windowMs: 10000, max: 60 }
        },
        { 
            path: '/media/:fileId', 
            method: 'get', 
            handler: 'getMediaFile',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 100 }
        },
        { 
            path: '/media/cleanup', 
            method: 'post', 
            handler: 'cleanTempMediaFiles',
            useAsync: true,
            rateLimit: { windowMs: 60000, max: 5 }
        }
    ],
    status: [
        { 
            path: '/statuses/listen/:number', 
            method: 'post', 
            handler: 'listenToStatusUpdates',
            useAsync: true
        },
        { 
            path: '/statuses/:number', 
            method: 'get', 
            handler: 'getStatuses',
            useAsync: true
        }
    ]
};

// Middleware para manejar errores específicos
const errorHandler = (err, req, res, next) => {
    logger.error('API Error:', err);
    
    if (err.type === 'validation') {
        return res.status(400).json({
            status: 'error',
            message: 'Validation failed',
            errors: err.errors
        });
    }

    if (err.type === 'auth') {
        return res.status(401).json({
            status: 'error',
            message: 'Authentication failed'
        });
    }

    res.status(500).json({
        status: 'error',
        message: 'Internal server error'
    });
};

// Register routes dynamically
Object.entries(routes).forEach(([group, routeConfigs]) => {
    routeConfigs.forEach(({ path, method, handler, rateLimit: routeLimit, useAsync = true }) => {
        if (typeof controller[handler] !== "function") {
            logger.error(`Handler '${handler}' not found in controller`);
            return;
        }

        const middlewares = [validateRequest(handler)];

        // Add route-specific rate limiter if configured
        if (routeLimit) {
            middlewares.push(rateLimit(routeLimit));
        }

        // Decidir si usar asyncHandler o simpleHandler
        const handlerWrapper = useAsync ? asyncHandler : simpleHandler;

        router[method](
            path,
            ...middlewares,
            handlerWrapper(controller[handler])
        );
    });
});

router.use(errorHandler);

// Health check endpoint
router.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;