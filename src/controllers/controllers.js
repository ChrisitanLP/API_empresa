const { MessageMedia } = require('whatsapp-web.js');
const WhatsAppService = require('../services/services');
const whatsappService = new WhatsAppService();
const { ValidationError, NotFoundError } = require('../utils/asyncHandler');
const logger = require('../conf/logger');
const mediaHandler = require('../utils/mediaHandler');


class WhatsAppController {
  constructor() {
  }

  /**
   * Get health metrics for all clients or specific client
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async getHealthMetrics(req, res) {
    try {
      const { number } = req.params;
      const metrics = await whatsappService.getHealthMetrics(number);
      
      res.json({ 
        success: true, 
        metrics 
      });
    } catch (error) {
      logger.error('Error getting health metrics:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Force reconnection for a specific client
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async forceReconnect(req, res) {
    try {
      const { number } = req.body;
      
      if (!number) {
        throw new ValidationError('Client number is required');
      }

      await whatsappService.forceReconnect(number);
      
      res.json({ 
        success: true, 
        message: `Reconnection initiated for ${number}` 
      });
    } catch (error) {
      logger.error('Error forcing reconnection:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Get detailed client state information
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async getClientStateInfo(req, res) {
    try {
      const { number } = req.params;
      const stateInfo = await whatsappService.getClientStateInfo(number);
      
      res.json({ 
        success: true, 
        state: stateInfo 
      });
    } catch (error) {
      logger.error('Error getting client state:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Get reconnection status for all clients
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async getReconnectionStatus(req, res) {
    try {
      const status = await whatsappService.getReconnectionStatus();
      
      res.json({ 
        success: true, 
        reconnectionStatus: status 
      });
    } catch (error) {
      logger.error('Error getting reconnection status:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async checkClientOperational(req, res) {
    try {
        const { number } = req.params;
        const client = WhatsAppClient.getClient(number);
        
        if (!client) {
            return res.json({
                success: false,
                operational: false,
                reason: 'Client not found'
            });
        }

        const checks = {
            authenticated: WhatsAppClient.isAuthenticated(number),
            ready: WhatsAppClient.isReady(number),
            hasPage: Boolean(client.pupPage),
            hasBrowser: Boolean(client.pupBrowser?.isConnected()),
            hasInfo: Boolean(client.info),
            stateAge: stateManager.getStateAge(number)
        };

        const operational = Object.values(checks).every(v => v === true || typeof v === 'number');

        res.json({
            success: true,
            operational,
            checks,
            number
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
  }

  // Método para descargar archivos
  async getMediaFile(req, res) {
      const { fileId } = req.params;

      try {
          const { stream, mimetype, size, filename } = await mediaHandler.getMediaStream(fileId);

          res.setHeader('Content-Type', mimetype);
          res.setHeader('Content-Length', size);
          res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
          res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 24h

          await pipeline(stream, res);

      } catch (error) {
          logger.error('Error serving media file:', error);
          
          if (error.message === 'File not found') {
              return res.status(404).json({ error: 'File not found' });
          }
          
          res.status(500).json({ error: 'Error retrieving file' });
      }
  }

  /**
   * Get QR code for client authentication
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async getQrCode(req, res) {
    try {
      const { number } = req.params;
      
      const qrCode = await whatsappService.getClientQr(number);

      if (!qrCode) {
        logger.warn(`QR no disponible para número: ${number}`);
        
        const clientExists = await whatsappService.checkClientExists(number);
        if (clientExists) {
          logger.info(`Cliente existe para ${number}, pero QR no disponible. Reintentando inicialización.`);
          try {
            // Opcionalmente, intentar reiniciar el cliente para generar nuevo QR
            await whatsappService.refreshClient(number);
            return res.status(202).json({ 
              success: false, 
              error: 'QR code generation in progress, please try again shortly' 
            });
          } catch (refreshError) {
            logger.error(`Error reiniciando cliente ${number}:`, refreshError);
          }
        }

        return res.status(404).json({ 
          success: false, 
          error: 'QR code not available' 
        });
      }
      
      res.json({ 
          success: true, 
          qr: qrCode 
      });
    } catch (error) {
      logger.error(`Error al obtener QR para ${req.params.number}: ${error.message}`);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Get client authentication status
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async getClientStatus(req, res) {
    try {
      const { number } = req.params;
      const isAuthenticated = await whatsappService.checkClientAuth(number);
      
      res.json({ 
          success: true, 
          isAuthenticated 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async getConnectionStatus(req, res) {
    try {
        const { number } = req.params;
        const clientStatus = await whatsappService.checkClientStatus(number);
        
        res.json({
            success: true,
            isAuthenticated: clientStatus.authenticated,
            isReady: clientStatus.ready,
            number: number
        });
    } catch (error) {
        res.status(500).json({
          success: false,
          error: error.message
      });
    }
  }

  /**
   * Add new WhatsApp client
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async addClient(req, res) {
    try {
      const { number } = req.body;
      if (!number) {
        throw new ValidationError('Number is required');
      }

      await whatsappService.createClient(number);
      res.json({ 
          success: true, 
          message: 'Client added successfully' 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Remove WhatsApp client
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async removeClient(req, res) {
    try {
      const { number } = req.body;
      
      if (!number) {
        throw new ValidationError('Client number is required');
      }

      await whatsappService.deleteClient(number);
      res.json({ 
          success: true, 
          message: `Client ${number} removed successfully` 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Save contact for specific client
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async saveContact(req, res) {
    try {
      const { clientNumber, contactNumber, contactName } = req.body;
      
      if (!clientNumber || !contactNumber || !contactName) {
        throw new ValidationError('Client number, contact number, and contact name are required');
      }

      await whatsappService.createContact(clientNumber, contactNumber, contactName);
      res.json({ 
          success: true, 
          message: 'Contact saved successfully' 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Get chats with pagination
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async getChats(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;

      if (page < 1 || limit < 1) {
        return res.status(400).json({ 
          success: false, 
          error: 'Parámetros de paginación inválidos' 
        });
      }

      const result = await whatsappService.fetchChats(page, limit);

      if (!result) {
        return res.status(500).json({
          success: false,
          error: 'No se pudo obtener respuesta del servicio'
        });
      }

      return res.json({
        success: true,
        currentPage: result.currentPage || page,
        totalPages: result.totalPages || 0,
        totalUnreadChats: result.totalUnreadChats || 0,
        totalChats: result.totalChats || 0,
        chats: result.chats || [],
        message: result.message || null
      });
    } catch (error) {
      logger.error('Error en getChats controller:', error);
      return res.status(500).json({ 
        success: false, 
        error: error?.message || 'Error al obtener chats'
      });
    }
  }

  /**
   * Get unread chats with pagination
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async getUnreadChats(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;

      if (page < 1 || limit < 1) {
        return res.status(400).json({ 
          success: false, 
          error: 'Parámetros de paginación inválidos' 
        });
      }

      const result = await whatsappService.fetchUnreadChats(page, limit);

      if (!result) {
        return res.status(500).json({
          success: false,
          error: 'No se pudo obtener respuesta del servicio'
        });
      }

      return res.json({
        success: true,
        currentPage: result.currentPage || page,
        totalPages: result.totalPages || 0,
        totalUnreadChats: result.totalUnreadChats || 0,
        unreadChats: result.chats || []
      });
    } catch (error) {
      logger.error('Error en getUnreadChats controller:', error);
      return res.status(500).json({ 
        success: false, 
        error: error?.message || 'Error al obtener chats no leídos'
      });
    }
  }

  /**
   * Get all group chats with members
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async getGroupChats(req, res) {
    try {
      const { clientId } = req.params;
      
      if (!clientId) {
        throw new ValidationError('Client ID is required');
      }

      const groups = await whatsappService.getGroupChats(clientId);
      
      res.json({
        success: true,
        totalGroups: groups.length,
        groups
      });
    } catch (error) {
      logger.error('Error in getGroupChats controller:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Mark chat as read
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async markChatAsRead(req, res) {
    try {
      const { clientId, tel, isGroup } = req.params;
      
      if (!clientId || !tel) {
        throw new ValidationError('Client ID and telephone number are required');
      }

      await whatsappService.markChatRead(clientId, tel, isGroup === 'true');
      res.json({ 
          success: true, 
          message: 'Chat marked as read' 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Mark chat as unread
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async markChatAsUnread(req, res) {
    try {
      const { clientId, tel, isGroup } = req.body;
      
      if (!clientId || !tel) {
        throw new ValidationError('Client ID and telephone number are required');
      }

      await whatsappService.markChatUnread(clientId, tel, isGroup);
      res.json({ 
          success: true, 
          message: 'Chat marked as unread' 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Get contacts with pagination
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async getContacts(req, res) {
    try {
      const page = parseInt(req.query.page, 10) || 1;

      if (page < 1) {
        return res.status(400).json({ 
          success: false, 
          error: 'Número de página inválido' 
        });
      }

      logger.info(`📞 Solicitando contactos - Página ${page}`);
      
      const result = await whatsappService.fetchContacts(page);

      if (!result) {
        logger.error('❌ El servicio fetchContacts devolvió null/undefined');
        return res.status(500).json({
          success: false,
          error: 'No se pudo obtener respuesta del servicio'
        });
      }

      // 🔹 Agregar información de diagnóstico en desarrollo
      const isDev = process.env.NODE_ENV !== 'production';
      
      return res.json({
        success: true,
        contacts: result.contacts || [],
        totalContacts: result.totalContacts || 0,
        currentPage: result.currentPage || page,
        totalPages: result.totalPages || 0,
        message: result.message || null,
        ...(isDev && { debug: { contactCount: (result.contacts || []).length } })
      });
    } catch (error) {
      logger.error('❌ Error crítico en getContacts controller:', {
        message: error.message,
        stack: error.stack,
        page: req.query.page
      });
      
      return res.status(500).json({
        success: false,
        error: error?.message || 'Error al obtener contactos',
        details: process.env.NODE_ENV !== 'production' ? error.stack : undefined
      });
    }
  }

  /**
   * Get media status (agregar a controlador existente)
   * Usar query param: GET /chats/:clientId/:tel/messages?mediaStatus=messageId
   */
  async getChatMessages(req, res) {
    try {
      const { clientId, tel } = req.params;
      const { mediaStatus } = req.query;

      // ✨ Si se solicita estado de media específica
      if (mediaStatus) {
        const status = await whatsappService.getMediaStatus(mediaStatus);
        return res.json({ success: true, mediaStatus: status });
      }

      // Flujo normal optimizado
      const messages = await whatsappService.getChatMessages(clientId, tel);
      
      res.json({ 
        success: true, 
        messages: messages,
        mediaQueueStats: await whatsappService.getMediaQueueStats()
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Get media download status
   */
  async getMediaStatus(req, res) {
    const { messageId } = req.params;
    
    const status = await service.getMediaStatus(messageId);
    
    res.json({
      success: true,
      data: status
    });
  }

  /**
   * Get group chat messages
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async getGroupChatMessages(req, res) {
    try {
      const { number, groupId } = req.params;
      const messages = await whatsappService.getGroupChatMessages(number, groupId);
      
      res.json({ 
          success: true, 
          messages: messages 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Send messages
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async sendMessage (req, res) {
    try {
      const { clientId, tel, mensaje } = req.body;
      await whatsappService.sendMessage(clientId, tel, mensaje);
      
      res.json({
        success: true,
        message: 'Message sent successfully'
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Send audio message
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */
  async sendAudio(req, res) {
    try {
      const { clientId, fileName, audioBase64, chatId, isGroup } = req.body;
      const message = '';

      await whatsappService.sendMessageOrFile({
        clientId,
        chatId,
        message,
        fileName,
        fileContent: audioBase64,
        isGroup
      });

      // Éxito
      res.json({
        success: true,
        message: 'Audio sent successfully',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Send messages on groups
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async sendGroupMessage (req, res) {
    try {
      const { clientId, groupId, mensaje } = req.body;
      await whatsappService.sendGroupMessage(clientId, groupId, mensaje);
      
      res.json({
        success: true,
        message: 'Group message sent successfully'
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Send messages or giles
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async sendMessageOrFile(req, res) {
  try {
    const { clientId, message, fileName, fileContent, chatId, isGroup } = req.body;
    
    await whatsappService.sendMessageOrFile({
      clientId,
      chatId,
      message,
      fileName,
      fileContent,
      isGroup
    });
    
    res.json({
      success: true,
      message: fileContent ? 'File sent successfully' : 'Message sent successfully'
    });
  } catch (error) {
    console.error('Error in sendMessageOrFile controller:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}

  /**
   * Send stickers
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async sendSticker (req, res) {
    try {
      const { clientId, tel, stickerPath, isGroup } = req.body;
      await whatsappService.sendMediaMessage({
        clientId,
        tel,
        mediaPath: stickerPath,
        isGroup,
        type: 'sticker'
      });
      
      res.json({
        success: true,
        message: 'Sticker sent successfully'
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Send Images
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async sendImage (req, res) {
    try {
      const { clientId, tel, imagePath, isGroup } = req.body;
      await whatsappService.sendMediaMessage({
        clientId,
        tel,
        mediaPath: imagePath,
        isGroup,
        type: 'image'
      });
      
      res.json({
        success: true,
        message: 'Image sent successfully'
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Send messages about products
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async sendMessageProduct (req, res) {
    try {
      const { clientId, tel, mensaje, imagen } = req.body;
      await whatsappService.sendProductMessage({
        clientId,
        tel,
        message: mensaje,
        image: imagen,
        isGroup: false
      });
      
      res.json({
        success: true,
        message: 'Product message sent successfully'
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  /**
   * Get info about accounts
   * @param {Request} req - Express request object
   * @param {Response} res - Express response object
   */

  async getAllAuthenticatedAccountsInfo(req, res) {
    try {
      const accounts = await whatsappService.getAllAuthenticatedAccountsInfo();

      res.json({ 
        success: true, 
        accounts 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async replyToMessage(req, res) {
    try {
      const { clientId, tel, messageId, reply, isGroup } = req.body;
      await whatsappService.replyToMessage(
        clientId, 
        tel, 
        messageId, 
        reply, 
        isGroup
      );

      res.json({ 
        success: true, 
        message: 'Respuesta enviada correctamente.' 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async deleteMessage(req, res) {
    try {
      const { clientId, tel, messageId, forEveryone, isGroup } = req.body;
      await whatsappService.deleteMessage(
        clientId, 
        tel, 
        messageId, 
        forEveryone, 
        isGroup
      );

      res.json({ 
        success: true, 
        message: 'Mensaje eliminado correctamente.' 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async forwardMessage(req, res) {
    try {
      const { clientId, fromTel, toTel, messageIds, isGroupFrom, isGroupTo } = req.body;

      await whatsappService.forwardMessages({
        clientId,
        fromTel,
        toTel,
        messageIds,
        isGroupFrom,
        isGroupTo
      });

      res.json({
        success: true,
        message: 'Mensajes reenviados correctamente.'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  async sendMessageProductGroup(req, res) {
    try {
      const { clientId, groupId, mensaje, imagen } = req.body;
      await whatsappService.sendMessageProductGroup({
        clientId, 
        groupId, 
        mmesage: mensaje, 
        image: imagen,
        isGroup: true
      });

      res.json({ 
        success: true, 
        message: 'Producto y imagen enviados correctamente.' 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  }

  async markMessageAsImportant (req, res) {
    try {
        const { clientId, tel, messageId, isGroup } = req.body;

        await whatsappService.markMessageAsImportant(
          clientId, 
          tel, 
          messageId, 
          isGroup
        );

        res.json({ 
          success: true, 
          message: 'Mensaje destacado.' 
        });
    } catch (error) {
        res.status(500).json({ 
          success: false, 
          message: 'Error interno del servidor.', 
          error: error.message 
        });
    }
  }

  async unmarkMessageAsImportant (req, res) {
    try {
        const { clientId, tel, messageId, isGroup } = req.body;
        
        await whatsappService.unmarkMessageAsImportant(
          clientId, 
          tel, 
          messageId, 
          isGroup
        );

        res.json({ 
          success: true, 
          message: 'Mensaje No destacado.' 
        });
    } catch (error) {
        res.status(500).json({ 
          success: false, 
          message: 'Error interno del servidor.', 
          error: error.message 
        });
    }
  }

  async editMessage (req, res) {
    try {
      const { clientId, tel, messageId, newContent, isGroup } = req.body;
      const result = await whatsappService.editMessage(
        clientId, 
        tel, 
        messageId, 
        newContent, 
        isGroup
      );

      res.json({ 
        success: true, 
        message: 'Mensaje editado exitosamente.', 
        data: result 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        message: error.message 
      });
    }
  }
  
  async muteChat (req, res) {
    try {
      const { clientId, tel, isGroup, unmuteDate } = req.body;
      await whatsappService.muteChat(
        clientId, 
        tel, 
        isGroup, 
        unmuteDate
      );

      res.json({ 
        success: true, 
        message: 'Chat silenciado correctamente.' 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        message: error.message 
      });
    }
  }

  async pinChat (req, res) {
    try {
      const { clientId, tel, isGroup } = req.body;
      await whatsappService.pinChat(
        clientId, 
        tel, 
        isGroup
      );

      res.json({ 
        success: true, 
        pinned: result 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        message: error.message 
      });
    }
  }
  
  async unpinChat (req, res) {
    try {
      const { clientId, tel, isGroup } = req.body;
      await whatsappService.unpinChat(
        clientId, 
        tel, 
        isGroup
      );

      res.json({ 
        success: true, 
        unpinned: result 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        message: error.message 
      });
    }
  }

  async sendMessageWithMention (req, res) {
    try {
      const { clientId, tel, isGroup, mentionTel, message } = req.body;
      await whatsappService.sendMessageWithMention(
        clientId, 
        tel, 
        isGroup, 
        mentionTel, 
        message
      );

      res.json({ 
        success: true, 
        message: 'Mensaje enviado correctamente con mención.'
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        message: error.message 
      });
    }
  }


  async getMessageInfo (req, res){
    try {
      const { clientId, tel, messageId, isGroup } = req.body;
      await whatsappService.getMessageInfo(
        clientId, 
        tel, 
        messageId, 
        isGroup
      );
  
      res.json({ 
        success: true, 
        message: 'Información del mensaje obtenido.'
      });
    } catch (error) {
      res.status(500).json({ 
        success: false,
        message: error.message 
      });
    }
  }
}

const whatsAppController = new WhatsAppController();
module.exports = whatsAppController;