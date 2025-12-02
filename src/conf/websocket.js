// websocket.js
const WebSocket = require('ws');
const logger = require('../conf/logger');

class WebSocketHandler {
    constructor(wss) {
        this.wss = wss;
        this.setupHeartbeat();
        this.subscribers = new Map();
    }

    setupHeartbeat() {
        this.wss.on('connection', (ws) => {
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });
            ws.on('error', this.handleError);
            this.handleConnection(ws);
        });

        setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    logger.info(`Terminando cliente inactivo: ${ws.ip || 'Unknown'}`);
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping(() => {});
            });
        }, 120000);
    }

    handleConnection(ws) {
        ws.ip = ws._socket.remoteAddress;
        logger.info(`Nueva conexión WebSocket establecida desde ${ws.ip}`);
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                logger.info(`Mensaje WebSocket recibido: ${JSON.stringify(data)}`);

                // Manejar suscripciones a números específicos
                if (data.action === "subscribe" && data.number) {
                    this.subscribeClient(ws, data.number);
                    return;
                }

                // Manejar mensajes ping para mantener viva la conexión
                if (data.action === "ping") {
                    ws.isAlive = true;
                    return;
                }

                this.broadcast('message', data);
            } catch (error) {
                logger.error('Error processing WebSocket message:', error);
            }
        });

        ws.on('close', () => {
            logger.info('WebSocket connection closed');
        });
    }

     // Suscribir un cliente a un número específico
    subscribeClient(ws, number) {
        ws.subscribedNumber = number;
        
        // Añadir a la lista de suscriptores
        if (!this.subscribers.has(number)) {
            this.subscribers.set(number, new Set());
        }
        this.subscribers.get(number).add(ws);
        
        logger.info(`Cliente ${ws.ip} suscrito al número: ${number}`);
    }

    unsubscribeClientFromAll(ws) {
        if (ws.subscribedNumber) {
            const subscriberSet = this.subscribers.get(ws.subscribedNumber);
            if (subscriberSet) {
                subscriberSet.delete(ws);
                if (subscriberSet.size === 0) {
                    this.subscribers.delete(ws.subscribedNumber);
                }
            }
            ws.subscribedNumber = null;
        }
    }

    handleMessage(ws, data) {
        if (!data || typeof data !== 'object' || !data.type) {
            logger.warn('Invalid WebSocket message received');
            return;
        }
        logger.info('Received message:', data);
    }

    handleError(error) {
        logger.error('WebSocket error:', error);
    }

    broadcast(eventType, data) {
        const payload = JSON.stringify({ eventType, data });
        logger.info(`Transmitiendo evento ${eventType} a todos los clientes`);
        
        this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(payload);
                } catch (error) {
                    logger.error(`Error enviando mensaje a cliente ${client.ip}:`, error);
                }
            }
        });
    }

    broadcastToSubscribers(eventType, data, number) {
        if (!number) {
            logger.warn('Intento de broadcast sin especificar número');
            return;
        }
        
        const payload = JSON.stringify({ eventType, data });
        const subscribers = this.subscribers.get(number);
        
        if (!subscribers || subscribers.size === 0) {
            logger.info(`No hay suscriptores para el número ${number}`);
            return;
        }
        
        logger.info(`Transmitiendo evento ${eventType} a ${subscribers.size} suscriptores del número ${number}`);
        
        subscribers.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(payload);
                } catch (error) {
                    logger.error(`Error enviando mensaje a suscriptor ${client.ip}:`, error);
                    client.terminate();
                }
            }
        });
    }
}

module.exports = WebSocketHandler;